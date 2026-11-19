import { createHash } from "node:crypto"
import { REVIEWER_AGENT_ID, REVIEWER_SYSTEM_PROMPT } from "./agent.ts"
import { parseConfig, type Config } from "./config.ts"
import { REVIEW_ESCALATED_PREFIX } from "./context.ts"
import { failureCategory } from "./diagnostics.ts"
import { JSON_ONLY_INSTRUCTION, OpenCodeClientAdapter, parseReviewerJson } from "./opencode-client.ts"
import {
  decide,
  denialMessage,
  MissingUserContextError,
  writeDecision,
  writeFailure,
  writeReceived,
  type LoggedRequest,
  type ReviewState,
} from "./reviewer.ts"
import { createServerRuntime } from "./server-runtime.ts"
import type { PermissionRequest, ReviewModel, ReviewerClient, RuntimeContext } from "./types.ts"

/** The `permission` `evaluate` hook event of the OpenCode 2 server plugin API. */
export interface PermissionEvaluation {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: { readonly type: "tool"; readonly messageID: string; readonly id: string }
  effect: "allow" | "ask" | "deny"
  message?: string
}

/** The part of the OpenCode 2 server plugin context the evaluate hook uses. */
export interface EvaluateHost {
  readonly options: Readonly<Record<string, unknown>>
  readonly location?: { readonly directory?: string }
  readonly permission: {
    hook(
      name: "evaluate",
      callback: (event: PermissionEvaluation) => Promise<void> | void,
    ): Promise<{ readonly dispose: () => Promise<void> }>
  }
  readonly session: {
    get(input: { sessionID: string }): Promise<unknown>
    context(input: { sessionID: string }): Promise<readonly unknown[]>
  }
  readonly generate: {
    text(input: { prompt: string; model?: ReviewModel }, options?: { signal?: AbortSignal }): Promise<{ text: string }>
  }
}

type SourcedEvaluation = PermissionEvaluation & { readonly source: NonNullable<PermissionEvaluation["source"]> }

function hasSource(event: PermissionEvaluation): event is SourcedEvaluation {
  return event.source !== undefined
}

type Verdict = { effect: PermissionEvaluation["effect"]; message?: string }

// OpenCode can evaluate the same call more than once: automation authorize
// (core/src/automation/code.ts) probes each tool with assertNotDenied and then
// allows under the creating call's source, so a call's allow or deny is reused
// for this long instead of reviewed again. The assert that follows those
// probes carries metadata (the program), so it is a new key and gets its own
// review. Webfetch re-checks only redirect targets, which are new resources.
const CALL_VERDICT_TTL_MS = 60_000

// timeoutMs allows up to 300 s for a slow reviewer, but the hook holds the
// agent's turn while it waits, so its own deadline stops at 30 s.
const MAX_HOOK_TIMEOUT_MS = 30_000

/**
 * Reviews `ask` evaluations in the server's permission evaluate hook, which
 * runs before OpenCode creates a permission request. An allow or deny set here
 * settles the call without publishing `permission.asked`, so notifiers never
 * alert on it. Any failure leaves the evaluation at `ask` with an escalation
 * message, and the human gets the normal prompt. Off unless `serverReview` is
 * true; shadow mode stays with the TUI reviewer, because a shadow review here
 * would hold the agent's turn for a verdict that is then discarded.
 */
export async function installEvaluateHook(
  host: EvaluateHost,
  overrides: { client?: ReviewerClient } = {},
): Promise<() => Promise<void>> {
  const config = parseConfig(host.options)
  if (!config.serverReview || config.shadow) return async () => {}
  const client = overrides.client ?? new ServerReviewerClient(host, config)
  // Fail closed, because the hook can escalate to the human instead of
  // reviewing on a missing session or a truncated context.
  const runtime = createServerRuntime(host, { failClosed: true })
  const state: ReviewState = {
    sharedReviews: new Map(),
    sessionApprovals: new Set(),
    releaseUnwatchedReviews: true,
    requireUserMessages: true,
  }
  const disposed = new AbortController()
  const verdicts = new Map<string, Verdict>()
  const expiries = new Set<ReturnType<typeof setTimeout>>()

  const remember = (key: string, verdict: Verdict) => {
    verdicts.set(key, verdict)
    const expiry = setTimeout(() => {
      expiries.delete(expiry)
      if (verdicts.get(key) === verdict) verdicts.delete(key)
    }, CALL_VERDICT_TTL_MS)
    expiry.unref?.()
    expiries.add(expiry)
  }

  const registration = await host.permission.hook("evaluate", async (event) => {
    // The hook must never throw: OpenCode awaits it inside the permission
    // check, and a rejection there would fail the tool call outright.
    try {
      // An evaluation without a tool source is an OpenCode probe made outside
      // a tool call, such as an automation run's assertNotDenied checks.
      // OpenCode settles those with its own rules and, for a run, its
      // Unattended ruleset, which it applies after this hook and only to an
      // evaluation left at ask, so a verdict here would replace that ruleset.
      if (event.effect !== "ask" || !hasSource(event) || event.agent === REVIEWER_AGENT_ID) return
      const key = callKey(event)
      const reused = verdicts.get(key)
      const verdict = reused ?? (await review(runtime.context, client, config, state, event, disposed.signal))
      // An escalation is not reused, so a later evaluation of the call gets a
      // fresh review instead of a failure that may have been transient.
      if (!reused && verdict.effect !== "ask") remember(key, verdict)
      apply(event, verdict)
    } catch (error) {
      apply(event, escalation(error))
    }
  })

  return async () => {
    disposed.abort("plugin disposed")
    for (const expiry of expiries) clearTimeout(expiry)
    expiries.clear()
    verdicts.clear()
    state.sharedReviews.clear()
    state.sessionApprovals.clear()
    runtime.clear()
    await registration.dispose()
  }
}

async function review(
  context: RuntimeContext,
  client: ReviewerClient,
  config: Config,
  state: ReviewState,
  event: SourcedEvaluation,
  disposedSignal: AbortSignal,
): Promise<Verdict> {
  const request: PermissionRequest = {
    // The hook runs before a request exists, so the tool call ID stands in.
    id: event.source.id,
    sessionID: event.sessionID,
    action: event.action,
    resources: [...event.resources],
    // The hook receives no `save` patterns, so allow_session cannot become a
    // reusable session approval here; it settles this one call.
    always: [],
    source: { type: "tool", messageID: event.source.messageID, callID: event.source.id },
    // The reviewer falls back to it when the call's tool input is not in the
    // session context, such as a call whose message is outside the window.
    ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
    protocol: "v2",
  }
  const logged: LoggedRequest = { ...request, protocol: "evaluate" }
  const startedAt = performance.now()
  writeReceived(config, logged)

  // The hook has no deadline of its own and the agent's turn waits on it, so
  // one budget covers context collection and every model attempt.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort("review timed out"), Math.min(config.timeoutMs, MAX_HOOK_TIMEOUT_MS))
  const signal = AbortSignal.any([disposedSignal, deadline.signal])
  const stop = abortRejection(signal)
  try {
    const outcome = await Promise.race([
      // A shared model review outlives this caller's deadline (see
      // ReviewState.releaseUnwatchedReviews), so only disposal bounds it here.
      decide(context, client, config, request, state, signal, disposedSignal),
      stop.promise,
    ])
    if (!outcome) throw stopError(deadline.signal)
    writeDecision(config, logged, startedAt, outcome.decision, outcome.source)
    return outcome.decision.kind === "deny"
      ? { effect: "deny", message: denialMessage(outcome.decision.reason) }
      : { effect: "allow" }
  } catch (error) {
    const failure = signal.aborted ? stopError(deadline.signal) : error
    writeFailure(config, logged, startedAt, failure)
    return escalation(failure)
  } finally {
    clearTimeout(timer)
    stop.cleanup()
  }
}

function apply(event: PermissionEvaluation, verdict: Verdict): void {
  event.effect = verdict.effect
  if (verdict.message) event.message = verdict.message
}

function escalation(error: unknown): Verdict {
  const cause = error instanceof MissingUserContextError
    ? "the session context held no user messages to review it against"
    : failureCategory(error) === "timeout"
      ? "the review timed out"
      : "the review failed"
  return {
    effect: "ask",
    message: `${REVIEW_ESCALATED_PREFIX}: ${cause}, so this request needs your approval.`,
  }
}

// Nested Code Mode calls arrive with their parent's call ID, so the metadata
// (the nested call's arguments) tells them apart.
function callKey(event: SourcedEvaluation): string {
  const metadata = createHash("sha256").update(stableJson(event.metadata ?? null)).digest("hex")
  return JSON.stringify([event.sessionID, event.source.messageID, event.source.id, event.action, event.resources, metadata])
}

/** JSON with object keys sorted, so equal metadata always hashes the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1))) : item,
  )
}

function stopError(deadline: AbortSignal): Error {
  return deadline.aborted ? new Error("Permission review timed out") : new Error("Permission review cancelled")
}

function abortRejection(signal: AbortSignal): { promise: Promise<never>; cleanup(): void } {
  let onAbort = () => {}
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Permission review stopped"))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  promise.catch(() => undefined)
  return { promise, cleanup: () => signal.removeEventListener("abort", onAbort) }
}

/**
 * Sends reviews to the configured structuredEndpoint when the model's provider
 * matches it, and otherwise through the server's `generate.text`, which takes
 * no system prompt or schema, so the reviewer prompt and JSON instruction ride
 * in the prompt text and the reply goes through the same tolerant JSON parser.
 */
class ServerReviewerClient implements ReviewerClient {
  private readonly endpoint: OpenCodeClientAdapter

  constructor(
    private readonly host: EvaluateHost,
    private readonly config: Config,
  ) {
    this.endpoint = new OpenCodeClientAdapter(undefined, {
      diagnosticsPath: config.diagnosticsPath,
      endpoint: config.structuredEndpoint,
    })
  }

  async generate(input: Parameters<ReviewerClient["generate"]>[0]): Promise<unknown> {
    if (this.config.structuredEndpoint?.providerID === input.model.providerID) return this.endpoint.generate(input)
    const result = await this.host.generate.text(
      { model: input.model, prompt: `${REVIEWER_SYSTEM_PROMPT}\n\n${input.prompt}\n\n${JSON_ONLY_INSTRUCTION}` },
      { signal: input.signal },
    )
    if (!isRecord(result) || typeof result.text !== "string") throw new Error("OpenCode reviewer returned no text output")
    return parseReviewerJson(result.text)
  }

  async reply(): Promise<never> {
    throw new Error("The evaluate hook settles requests in place and never replies")
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
