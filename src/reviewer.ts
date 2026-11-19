import { OpenCodeClientAdapter } from "./opencode-client.ts"
import { parseConfig, type Config } from "./config.ts"
import {
  collectReviewInput,
  isRequestPending,
  normalizeAskedEvent,
  normalizeRepliedEvent,
} from "./context.ts"
import { applyDeterministicPolicy } from "./policy.ts"
import { buildReviewPrompt } from "./prompt.ts"
import type {
  Decision,
  PermissionProtocol,
  PermissionRequest,
  ReviewInput,
  ReviewModel,
  ReviewerClient,
  RuntimeContext,
} from "./types.ts"
import { parseDecision } from "./verdict.ts"
import { describeError, failureCategory, writeDiagnostic, type DiagnosticRecord } from "./diagnostics.ts"

export interface ReviewerOverrides {
  client?: ReviewerClient
  protocols?: PermissionProtocol[]
  onDecision?(request: PermissionRequest, decision: Decision, shadow: boolean): void
  onFailure?(request: PermissionRequest, error: unknown): void
}

export function installReviewer(context: RuntimeContext, overrides: ReviewerOverrides = {}): () => void {
  const config = parseConfig(context.options)
  const client = overrides.client ?? new OpenCodeClientAdapter(context.client, { diagnosticsPath: config.diagnosticsPath, endpoint: config.structuredEndpoint })
  const inFlight = new Map<string, AbortController>()
  const state: ReviewState = { sharedReviews: new Map(), sessionApprovals: new Set() }
  const sharedReviewController = new AbortController()
  const configuredProtocols: PermissionProtocol[] = overrides.protocols ?? ["stable", "v2"]
  const protocols = new Set(configuredProtocols)
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    event: "plugin_started",
  })
  void client.prewarm?.().catch(() => undefined)

  const offReplied = context.data.on("permission.v2.replied", (event) => {
    const reply = normalizeRepliedEvent(event)
    if (reply) cancelReview(config, inFlight, reply.requestID)
  })
  const offStableReplied = context.data.on("permission.replied", (event) => {
    const reply = normalizeRepliedEvent(event)
    if (reply) cancelReview(config, inFlight, reply.requestID)
  })

  const offAsked = context.data.on("permission.v2.asked", (event) => {
    const asked = normalizeAskedEvent(event)
    if (!asked || !protocols.has(asked.protocol) || inFlight.has(asked.id))
      return

    const controller = new AbortController()
    const startedAt = performance.now()
    writeReceived(config, asked)
    inFlight.set(asked.id, controller)
    void reviewAndReply(context, client, config, asked, controller.signal, overrides, startedAt, state, sharedReviewController.signal)
      .catch(async (error) => {
        if (controller.signal.aborted) return
        await rejectAfterFailure(context, client, config, asked, startedAt, error, overrides)
      })
      .finally(() => {
        if (inFlight.get(asked.id) === controller) inFlight.delete(asked.id)
      })
  })
  const offStableAsked = context.data.on("permission.asked", (event) => {
    const normalized = normalizeAskedEvent(event)
    const asked = normalized && configuredProtocols.length === 1
      ? { ...normalized, protocol: configuredProtocols[0]! }
      : normalized
    if (!asked || !protocols.has(asked.protocol) || inFlight.has(asked.id))
      return
    const controller = new AbortController()
    const startedAt = performance.now()
    writeReceived(config, asked)
    inFlight.set(asked.id, controller)
    void reviewAndReply(context, client, config, asked, controller.signal, overrides, startedAt, state, sharedReviewController.signal)
      .catch(async (error) => {
        if (controller.signal.aborted) return
        await rejectAfterFailure(context, client, config, asked, startedAt, error, overrides)
      })
      .finally(() => {
        if (inFlight.get(asked.id) === controller) inFlight.delete(asked.id)
      })
  })

  return () => {
    offAsked()
    offStableAsked()
    offReplied()
    offStableReplied()
    for (const controller of inFlight.values()) controller.abort("plugin disposed")
    sharedReviewController.abort("plugin disposed")
    inFlight.clear()
    state.sharedReviews.clear()
    state.sessionApprovals.clear()
  }
}

export interface ReviewState {
  sharedReviews: Map<string, Promise<Decision>>
  sessionApprovals: Set<string>
}

export type DecisionSource = "policy" | "model" | "session"

export interface ReviewOutcome {
  decision: Decision
  source: DecisionSource
  input: ReviewInput
}

/**
 * Decides one permission request without replying to it: deterministic policy
 * first, then a reusable session approval, then one model review shared by
 * concurrent identical requests. Both the TUI reply path and the server
 * evaluate hook call this, so they apply the same rules. Returns undefined
 * when parentSignal aborts; reviewSignal bounds the model review itself.
 */
export async function decide(
  context: RuntimeContext,
  client: ReviewerClient,
  config: Config,
  request: PermissionRequest,
  state: ReviewState,
  parentSignal: AbortSignal,
  reviewSignal: AbortSignal,
): Promise<ReviewOutcome | undefined> {
  const input = await collectReviewInput(context, request, config.userMessageCount)
  if (parentSignal.aborted) return undefined

  const policyDecision = applyDeterministicPolicy(input)
  const approvalKey = reusableApprovalKey(config, request, input)
  const cachedDecision = !policyDecision && approvalKey && state.sessionApprovals.has(approvalKey)
    ? {
        kind: "allow" as const,
        reasonCode: "session_approval_reused",
        reason: "Reuses an approved narrow pattern from this session.",
      }
    : undefined
  const reviewKey = concurrentReviewKey(request, input)
  let shared = state.sharedReviews.get(reviewKey)
  if (!policyDecision && !cachedDecision && !shared) {
    shared = modelDecision(context, client, config, input, reviewSignal)
    state.sharedReviews.set(reviewKey, shared)
    void shared.finally(() => {
      if (state.sharedReviews.get(reviewKey) === shared) state.sharedReviews.delete(reviewKey)
    }).catch(() => undefined)
  }
  const decision = policyDecision ?? cachedDecision ?? (await shared!)
  if (parentSignal.aborted) return undefined

  if (approvalKey && (decision.kind === "allow" || decision.kind === "allow_session")) {
    state.sessionApprovals.add(approvalKey)
  }
  return { decision, source: decisionSource(policyDecision, cachedDecision), input }
}

export function denialMessage(reason: string): string {
  return `Auto Permissions blocked this action: ${reason}`
}

async function reviewAndReply(
  context: RuntimeContext,
  client: ReviewerClient,
  config: Config,
  request: PermissionRequest,
  parentSignal: AbortSignal,
  overrides: ReviewerOverrides,
  startedAt: number,
  state: ReviewState,
  sharedReviewSignal: AbortSignal,
): Promise<void> {
  const outcome = await decide(context, client, config, request, state, parentSignal, sharedReviewSignal)
  if (!outcome) return
  const { decision, source, input } = outcome

  overrides.onDecision?.(request, decision, config.shadow)
  if (config.shadow) {
    writeDecision(config, request, startedAt, decision, source)
    return
  }

  const pending = await isRequestPending(context, request)
  if (!pending || parentSignal.aborted) return

  if (decision.kind === "allow" || decision.kind === "allow_session") {
    const reply = decision.kind === "allow_session" && eligibleForSessionApproval(config, request, input)
      ? "always"
      : "once"
    const result = await client.reply({
      sessionID: request.sessionID,
      requestID: request.id,
      reply,
      protocol: request.protocol,
    })
    writeDecision(config, request, startedAt, decision, source, result, reply === "always" ? "session" : "once")
    return
  }

  const result = await client.reply({
    sessionID: request.sessionID,
    requestID: request.id,
    reply: "reject",
    message: denialMessage(decision.reason),
    protocol: request.protocol,
  })
  context.showToast?.({ title: "Blocked", message: decision.reason, variant: "warning", duration: 4_000 })
  writeDecision(config, request, startedAt, decision, source, result)
  if (result === "replied") context.resumeAfterDenial?.(request.sessionID, decision.reason)
}

async function rejectAfterFailure(
  context: RuntimeContext,
  client: ReviewerClient,
  config: Config,
  request: PermissionRequest,
  startedAt: number,
  error: unknown,
  overrides: ReviewerOverrides,
): Promise<void> {
  writeFailure(config, request, startedAt, error)
  overrides.onFailure?.(request, error)
  if (config.shadow || !(await isRequestPending(context, request))) return

  const category = failureCategory(error)
  const reason = category === "timeout"
    ? "Permission review timed out, so the action was blocked; continue with a narrower or lower-risk step and retry only if needed."
    : "Permission review failed, so the action was blocked; continue with a narrower or lower-risk step and retry only if needed."
  const result = await client.reply({
    sessionID: request.sessionID,
    requestID: request.id,
    reply: "reject",
    message: denialMessage(reason),
    protocol: request.protocol,
  })
  context.showToast?.({ title: "Blocked", message: reason, variant: "warning", duration: 4_000 })
  if (result === "replied") context.resumeAfterDenial?.(request.sessionID, reason)
}

function eligibleForSessionApproval(
  config: Config,
  request: PermissionRequest,
  input: Awaited<ReturnType<typeof collectReviewInput>>,
): boolean {
  if (!config.sessionApprovals || request.always.length === 0) return false
  if (request.always.some((pattern) => isBroadPattern(pattern))) return false
  if ([...request.resources, ...request.always].some((value) => isSensitiveTarget(value))) return false
  if (["read", "glob", "grep", "list", "lsp"].includes(request.action)) return true
  if (request.action !== "shell" && request.action !== "bash") return false
  const command = typeof input.request.toolInput === "object" && input.request.toolInput !== null
    ? Reflect.get(input.request.toolInput, "command")
    : input.request.resources.join(" && ")
  if (typeof command !== "string") return false
  return !isSensitiveTarget(command)
    && !/\b(?:sudo|rm|rmdir|shred|git\s+(?:push|reset|clean|rebase)|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|deploy|terraform\s+apply|kubectl\s+(?:apply|delete)|curl\b[^\n|]*\|\s*(?:ba|z|k)?sh)\b/i.test(command)
}

function reusableApprovalKey(
  config: Config,
  request: PermissionRequest,
  input: Awaited<ReturnType<typeof collectReviewInput>>,
): string | undefined {
  if (!eligibleForSessionApproval(config, request, input)) return undefined
  return JSON.stringify([input.context.rootSessionID, request.action, request.always])
}

function concurrentReviewKey(
  request: PermissionRequest,
  input: Awaited<ReturnType<typeof collectReviewInput>>,
): string {
  return JSON.stringify([input.context.rootSessionID, request.action, request.resources, input.request.toolInput])
}

function decisionSource(
  policyDecision: Decision | null,
  cachedDecision: Decision | undefined,
): DecisionSource {
  return policyDecision ? "policy" : cachedDecision ? "session" : "model"
}

function isBroadPattern(pattern: string): boolean {
  const value = pattern.trim()
  return !value || value === "*" || value === "**" || /^[\\/]?(?:tmp|home|Users)[\\/][*?]+$/i.test(value)
    || /^[*?]/.test(value) || /\*\*/.test(value)
    || /^(?:git|npm|pnpm|yarn|bun|cargo|go|sudo|rm)\s+[*?]+$/i.test(value)
}

function isSensitiveTarget(value: string): boolean {
  return /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|Keychains?|credentials?|tokens?)(?:[\\/]|$)|(?:^|[\\/])\.env(?:\.|$)/i.test(value)
}

/** The request fields a decision-log record carries; protocol may be "evaluate". */
export type LoggedRequest = Pick<PermissionRequest, "id" | "sessionID" | "action" | "resources"> & {
  protocol: NonNullable<DiagnosticRecord["protocol"]>
}

export function writeDecision(
  config: Config,
  request: LoggedRequest,
  startedAt: number,
  decision: Decision,
  source: DecisionSource,
  replyResult?: "replied" | "not_found" | "manual",
  approvalScope?: "once" | "session",
): void {
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    protocol: request.protocol,
    action: request.action,
    resourceCount: request.resources.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    event: "decision",
    source,
    decision: decision.kind,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    shadow: config.shadow,
    ...(replyResult ? { replyResult } : {}),
    ...(approvalScope ? { approvalScope } : {}),
  })
}

export function writeFailure(config: Config, request: LoggedRequest, startedAt: number, error: unknown): void {
  const described = describeError(error)
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    protocol: request.protocol,
    action: request.action,
    resourceCount: request.resources.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    event: "failure",
    failureCategory: failureCategory(error),
    errorName: described.name,
    errorMessage: described.message,
    ...(described.tag ? { errorTag: described.tag } : {}),
    ...(described.code !== undefined ? { errorCode: described.code } : {}),
    ...(described.status !== undefined ? { errorStatus: described.status } : {}),
  })
}

export function writeReceived(config: Config, request: LoggedRequest): void {
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    event: "request_received",
    requestID: request.id,
    sessionID: request.sessionID,
    protocol: request.protocol,
    action: request.action,
    resourceCount: request.resources.length,
  })
}

function cancelReview(config: Config, inFlight: Map<string, AbortController>, requestID: string): void {
  const controller = inFlight.get(requestID)
  if (!controller || controller.signal.aborted) return
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    event: "request_cancelled",
    requestID,
  })
  controller.abort("permission resolved")
}

async function modelDecision(
  context: RuntimeContext,
  client: ReviewerClient,
  config: Config,
  input: Awaited<ReturnType<typeof collectReviewInput>>,
  parentSignal: AbortSignal,
): Promise<Decision> {
  const inheritedModel = input.context.model
  const candidates: ReviewModel[] = []
  if (config.model) {
    candidates.push(config.model)
    if (inheritedModel && !sameModelId(inheritedModel, config.model)) {
      // Reviewer-only variants may not exist on the session's provider.
      candidates.push(inheritedModel)
    }
  } else if (inheritedModel) {
    candidates.push({ ...inheritedModel, ...(config.variant ? { variant: config.variant } : {}) })
  }
  if (candidates.length === 0) throw new Error("Auto Permissions could not determine the requesting session model")

  let lastError: unknown
  for (const [index, model] of candidates.entries()) {
    if (parentSignal.aborted) throw new DOMException("Review cancelled", "AbortError")
    const diagnostic = {
      sessionID: input.context.rootSessionID,
      providerID: model.providerID,
      modelID: model.id,
      ...(model.variant ? { variant: model.variant } : {}),
      attempt: index + 1,
    }
    writeDiagnostic(config.diagnosticsPath, {
      ...diagnostic, timestamp: new Date().toISOString(), event: "model_attempt",
    })
    try {
      const decision = await singleModelDecision(client, config, input, parentSignal, model)
      writeDiagnostic(config.diagnosticsPath, {
        ...diagnostic, timestamp: new Date().toISOString(), event: "model_decision", decision: decision.kind,
      })
      return decision
    } catch (error) {
      // A cancelled review must not trigger a fallback review.
      if (parentSignal.aborted) throw error
      writeDiagnostic(config.diagnosticsPath, {
        ...diagnostic, timestamp: new Date().toISOString(), event: "model_failure",
        failureCategory: failureCategory(error), errorMessage: describeError(error).message,
      })
      lastError = error
    }
  }
  throw lastError
}

/**
 * Tries the dedicated reviewer model first and falls back to the requesting
 * session's model once when that model times out, errors, or returns an
 * invalid decision. A valid deny verdict is authoritative and never retried
 * on another model. Each attempt receives the full timeout budget so a slow
 * primary does not consume the fallback's window.
 */
async function singleModelDecision(
  client: ReviewerClient,
  config: Config,
  input: Awaited<ReturnType<typeof collectReviewInput>>,
  parentSignal: AbortSignal,
  model: ReviewModel,
): Promise<Decision> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort("review timed out"), config.timeoutMs)
  const abort = () => timeout.abort(parentSignal.reason)
  parentSignal.addEventListener("abort", abort, { once: true })
  let rejectOnAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(new DOMException("Review aborted", "AbortError"))
    timeout.signal.addEventListener("abort", rejectOnAbort, { once: true })
  })

  try {
    if (parentSignal.aborted) abort()
    let structured: unknown
    try {
      structured = await Promise.race([aborted, client.generate({
        prompt: buildReviewPrompt(input),
        model,
        parentSessionID: input.context.rootSessionID,
        ...(input.context.directory ? { location: { directory: input.context.directory } } : {}),
        signal: timeout.signal,
      })])
    } catch (error) {
      if (timeout.signal.aborted && !parentSignal.aborted) throw new Error("Permission review timed out")
      throw error
    }
    const decision = parseDecision(structured)
    if (!decision) throw new Error("Reviewer returned an invalid decision")
    return decision
  } finally {
    clearTimeout(timer)
    timeout.signal.removeEventListener("abort", rejectOnAbort)
    parentSignal.removeEventListener("abort", abort)
  }
}

function sameModelId(left: ReviewModel, right: ReviewModel): boolean {
  return left.providerID === right.providerID && left.id === right.id
}
