import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REVIEW_ESCALATED_PREFIX } from "../src/context.ts"
import { installEvaluateHook, type EvaluateHost, type PermissionEvaluation } from "../src/evaluate.ts"
import type { ReviewerClient } from "../src/types.ts"

const ALLOW = { decision: "allow", reasonCode: "requested_action", reason: "The user requested this action." }
const DENY = {
  decision: "deny",
  reasonCode: "missing_authorization",
  reason: "Authorization is missing; continue with a safer alternative.",
}

function harness(options: Record<string, unknown> = {}) {
  let hook: ((event: PermissionEvaluation) => Promise<void> | void) | undefined
  let disposed = false
  const generated: Parameters<ReviewerClient["generate"]>[0][] = []
  const replies: unknown[] = []
  const host: EvaluateHost = {
    options: { model: "reviewer/fast", serverReview: true, ...options },
    location: { directory: "/repo" },
    permission: {
      async hook(_name, callback) {
        hook = callback
        return { dispose: async () => void (disposed = true) }
      },
    },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID }),
      context: async () => [
        { id: "msg_user", type: "user", text: "Push the feature branch." },
        {
          id: "msg_assistant",
          type: "assistant",
          model: { providerID: "example", id: "main" },
          content: [{ id: "call_1", type: "tool", name: "shell", state: { input: { command: "git push origin feature" } } }],
        },
      ],
    },
    generate: { text: async () => ({ text: JSON.stringify(ALLOW) }) },
  }
  const client: ReviewerClient = {
    async generate(input) {
      generated.push(input)
      return ALLOW
    },
    async reply(input) {
      replies.push(input)
      return "replied"
    },
  }
  // `source: null` sends an evaluation with no tool source.
  const evaluate = async (
    event: Partial<Omit<PermissionEvaluation, "source">> & { source?: PermissionEvaluation["source"] | null } = {},
  ) => {
    const { source = { type: "tool", messageID: "msg_assistant", id: "call_1" }, ...rest } = event
    const value: PermissionEvaluation = {
      sessionID: "ses_root",
      agent: "build",
      action: "shell",
      resources: ["git push origin feature"],
      ...(source ? { source } : {}),
      effect: "ask",
      ...rest,
    }
    if (!hook) throw new Error("evaluate hook was not registered")
    await hook(value)
    return value
  }
  return { host, client, generated, replies, evaluate, registered: () => hook !== undefined, disposed: () => disposed }
}

describe("installEvaluateHook", () => {
  test("allows a reviewer-approved ask in place, so no permission request is created", async () => {
    const app = harness()
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    const event = await app.evaluate()

    expect(event.effect).toBe("allow")
    expect(event.message).toBeUndefined()
    expect(app.generated).toHaveLength(1)
    expect(app.generated[0]?.prompt).toContain("git push origin feature")
    expect(app.generated[0]?.prompt).toContain("Push the feature branch.")
    expect(app.replies).toEqual([])
    await dispose()
    expect(app.disposed()).toBeTrue()
  })

  test("treats allow_session as a one-call allow", async () => {
    const app = harness()
    app.client.generate = async () => ({ ...ALLOW, decision: "allow_session" })
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    expect((await app.evaluate()).effect).toBe("allow")
    await dispose()
  })

  test("denies with the reviewer's reason as the message", async () => {
    const app = harness()
    app.client.generate = async () => DENY
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    const event = await app.evaluate()

    expect(event.effect).toBe("deny")
    expect(event.message).toBe(`Auto Permissions blocked this action: ${DENY.reason}`)
    expect(app.replies).toEqual([])
    await dispose()
  })

  test("leaves a timed-out review at ask within its own deadline", async () => {
    const app = harness({ timeoutMs: 100 })
    // Ignores its abort signal, like a provider call that never returns.
    app.client.generate = () => new Promise(() => {})
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    const startedAt = performance.now()
    const event = await app.evaluate()

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(event.effect).toBe("ask")
    expect(event.message).toBe(`${REVIEW_ESCALATED_PREFIX}: the review timed out, so this request needs your approval.`)
    await dispose()
  })

  test("bounds a stalled context lookup by the same deadline", async () => {
    const app = harness({ timeoutMs: 100 })
    app.host.session.context = () => new Promise(() => {})
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    const startedAt = performance.now()
    const event = await app.evaluate()

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(event.effect).toBe("ask")
    expect(event.message).toStartWith(`${REVIEW_ESCALATED_PREFIX}: the review timed out`)
    expect(app.generated).toEqual([])
    await dispose()
  })

  test.each(["reviewer", "session context"])("leaves the evaluation at ask when the %s throws", async (failing) => {
    const app = harness()
    if (failing === "reviewer") app.client.generate = async () => { throw new Error("provider unavailable") }
    else app.host.session.context = async () => { throw new Error("session store unavailable") }
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    const event = await app.evaluate()

    expect(event.effect).toBe("ask")
    expect(event.message).toBe(`${REVIEW_ESCALATED_PREFIX}: the review failed, so this request needs your approval.`)
    await dispose()
  })

  test("leaves allow evaluations and the reviewer's own evaluations untouched", async () => {
    const app = harness()
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    const allowed = await app.evaluate({ effect: "allow" })
    const reviewer = await app.evaluate({ agent: "auto-permissions-reviewer" })

    expect(allowed.effect).toBe("allow")
    expect(reviewer.effect).toBe("ask")
    expect(reviewer.message).toBeUndefined()
    expect(app.generated).toEqual([])
    await dispose()
  })

  test("settles routine commands by policy without a model review", async () => {
    const app = harness()
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    // No source, so the policy reads the command from the resources.
    const event = await app.evaluate({ resources: ["git status"], source: null })

    expect(event.effect).toBe("allow")
    expect(app.generated).toEqual([])
    await dispose()
  })

  test("reviews one tool call once when the tool evaluates it again", async () => {
    const app = harness()
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    const first = await app.evaluate()
    const second = await app.evaluate()
    const otherCall = await app.evaluate({ source: { type: "tool", messageID: "msg_assistant", id: "call_2" } })

    expect([first.effect, second.effect, otherCall.effect]).toEqual(["allow", "allow", "allow"])
    expect(app.generated).toHaveLength(2)
    await dispose()
  })

  test.each([{}, { serverReview: false }, { shadow: true }])("does not register a hook for %p", async (options) => {
    const app = harness({ serverReview: undefined, ...options, ...("shadow" in options ? { serverReview: true } : {}) })
    const dispose = await installEvaluateHook(app.host, { client: app.client })

    expect(app.registered()).toBeFalse()
    await dispose()
  })

  test("records decisions and failures with the evaluate protocol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auto-permissions-evaluate-"))
    const debug = join(directory, "decisions.jsonl")
    try {
      const app = harness({ debug, timeoutMs: 100 })
      let calls = 0
      app.client.generate = async () => {
        if (++calls === 1) return DENY
        throw new Error("provider unavailable")
      }
      const dispose = await installEvaluateHook(app.host, { client: app.client })

      await app.evaluate()
      await app.evaluate({ source: { type: "tool", messageID: "msg_assistant", id: "call_2" } })
      await dispose()
      await new Promise((resolve) => setTimeout(resolve, 50))

      const records = (await readFile(debug, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      const outcomes = records.filter((record) => record.event === "decision" || record.event === "failure")
      expect(outcomes).toMatchObject([
        { event: "decision", protocol: "evaluate", requestID: "call_1", source: "model", decision: "deny" },
        { event: "failure", protocol: "evaluate", requestID: "call_2", failureCategory: "error" },
      ])
      expect(records.filter((record) => record.event === "request_received").map((record) => record.protocol)).toEqual([
        "evaluate",
        "evaluate",
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reviews through generate.text when no structured endpoint matches the model", async () => {
    const app = harness()
    const prompts: string[] = []
    app.host.generate.text = async (input) => {
      prompts.push(input.prompt)
      return { text: "```json\n" + JSON.stringify(DENY) + "\n```" }
    }
    const dispose = await installEvaluateHook(app.host)

    const event = await app.evaluate()

    expect(event.effect).toBe("deny")
    expect(prompts[0]).toStartWith("You are an automatic permission reviewer")
    expect(prompts[0]).toContain("Return only one JSON object")
    await dispose()
  })
})
