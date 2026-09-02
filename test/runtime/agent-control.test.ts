import { describe, expect, it } from "vitest"
import type { ModelMessage } from "../../src/kernel/events.ts"
import {
  type AgentControlAdapter,
  type AgentRunOutcome,
  createAgentControl,
  type ForkTurns,
} from "../../src/runtime/agent-control.ts"

const TARGET = { provider: "faux", model: "scripted" }

describe("agent control", () => {
  it("spawns in the background and reports completion through wait and mailbox", async () => {
    const harness = createHarness()
    const root = harness.control.bind("root_session", TARGET)

    const spawned = await root.spawn({
      taskName: "survey",
      message: "inspect",
      agentType: "general",
      forkTurns: "all",
    })

    expect(spawned).toEqual({
      agentId: "agent_1",
      taskName: "survey",
      path: "/root/survey",
    })
    await expect(root.list()).resolves.toMatchObject([
      { agentId: "agent_1", path: "/root/survey", status: "running" },
    ])
    expect(harness.children[0]?.forkedContext).toEqual({
      sourceSessionId: "root_session",
      messages: [
        { role: "user", content: [{ type: "text", text: "parent prefix" }] },
      ],
    })

    harness.runs.get("agent_1")?.[0]?.resolve({
      type: "completed",
      text: "findings",
    })
    const updates = await root.wait(1_000)

    expect(updates).toEqual([
      {
        agentId: "agent_1",
        path: "/root/survey",
        status: { completed: "findings" },
      },
    ])
    expect(harness.deliveredMessages).toEqual([
      expect.objectContaining({
        sessionId: "root_session",
        text: expect.stringContaining("findings"),
      }),
    ])
  })

  it("allows two delegation levels and rejects a third without removing spawn", async () => {
    const harness = createHarness({ maxDepth: 2, maxConcurrentAgents: 4 })
    const root = harness.control.bind("root_session", TARGET)
    const child = await root.spawn({
      taskName: "child",
      message: "child work",
      agentType: "general",
      forkTurns: "none",
    })
    const childControl = harness.control.bind(child.agentId, TARGET)
    const grandchild = await childControl.spawn({
      taskName: "grandchild",
      message: "nested work",
      agentType: "explore",
      forkTurns: "none",
    })

    await expect(
      harness.control.bind(grandchild.agentId, TARGET).spawn({
        taskName: "too_deep",
        message: "should fail",
        agentType: "general",
        forkTurns: "none",
      }),
    ).rejects.toMatchObject({
      code: "agent_depth_limit_reached",
    })
    expect(harness.control.runtimeContext(grandchild.agentId)).toMatchObject({
      path: "/root/child/grandchild",
      depth: 2,
      maxDepth: 2,
      agentType: "explore",
    })
  })

  it("supports message, follow-up, interrupt, and canonical target lookup", async () => {
    const harness = createHarness()
    const root = harness.control.bind("root_session", TARGET)
    const child = await root.spawn({
      taskName: "worker",
      message: "start",
      agentType: "general",
      forkTurns: "none",
    })

    await root.sendMessage({ target: "/root/worker", message: "extra context" })
    expect(harness.deliveredMessages).toEqual([
      expect.objectContaining({
        sessionId: child.agentId,
        text: expect.stringContaining("extra context"),
      }),
    ])

    await root.followup({ target: "worker", message: "next task" })
    expect(harness.runRequests).toEqual([
      { sessionId: child.agentId, message: "start", target: TARGET },
    ])
    await expect(root.interrupt(child.agentId)).resolves.toEqual({
      agentId: child.agentId,
      path: "/root/worker",
      previousStatus: "running",
    })
    expect(harness.interrupted).toEqual([child.agentId])
  })

  it("scopes stable message ids by the sending agent", async () => {
    const harness = createHarness()
    const root = harness.control.bind("root_session", TARGET)
    const first = await root.spawn({
      taskName: "first",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    const second = await root.spawn({
      taskName: "second",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })

    await harness.control.bind(first.agentId, TARGET).sendMessage({
      target: "root_session",
      message: "from first",
      messageId: "tool_call_same",
    })
    await harness.control.bind(second.agentId, TARGET).sendMessage({
      target: "root_session",
      message: "from second",
      messageId: "tool_call_same",
    })

    const deliveries = harness.deliveredMessages.slice(-2)
    expect(deliveries.map((delivery) => delivery.messageId)).toEqual([
      `agent_message:${first.agentId}:tool_call_same`,
      `agent_message:${second.agentId}:tool_call_same`,
    ])
  })

  it("starts a follow-up queued while the previous worker is settling", async () => {
    const allowFollowup = deferred<void>()
    const harness = createHarness({
      ensureLoaded: () => allowFollowup.promise,
      onRunResolved: () => queueMicrotask(() => allowFollowup.resolve()),
    })
    const root = harness.control.bind("root_session", TARGET)
    const child = await root.spawn({
      taskName: "worker",
      message: "first",
      agentType: "general",
      forkTurns: "none",
    })
    const followup = root.followup({
      target: child.agentId,
      message: "second",
    })

    expect(harness.runRequests.map((request) => request.message)).toEqual([
      "first",
    ])
    harness.runs.get(child.agentId)?.[0]?.resolve({
      type: "completed",
      text: "first result",
    })
    await followup
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.runRequests.map((request) => request.message)).toEqual([
      "first",
      "second",
    ])
    await expect(root.wait(1_000)).resolves.toEqual([
      {
        agentId: child.agentId,
        path: "/root/worker",
        status: { completed: "first result" },
      },
    ])
    harness.runs.get(child.agentId)?.[1]?.resolve({
      type: "completed",
      text: "second result",
    })
    await expect(root.wait(1_000)).resolves.toEqual([
      {
        agentId: child.agentId,
        path: "/root/worker",
        status: { completed: "second result" },
      },
    ])
  })

  it("reserves concurrency before asynchronous child creation", async () => {
    const harness = createHarness({ maxConcurrentAgents: 2 })
    const root = harness.control.bind("root_session", TARGET)
    const results = await Promise.allSettled([
      root.spawn({
        taskName: "first",
        message: "first",
        agentType: "general",
        forkTurns: "none",
      }),
      root.spawn({
        taskName: "second",
        message: "second",
        agentType: "general",
        forkTurns: "none",
      }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ])
    expect(
      results.find((result) => result.status === "rejected")?.reason,
    ).toMatchObject({ code: "agent_concurrency_limit_reached" })
  })

  it("reserves a task path before concurrent same-name spawn checks", async () => {
    const harness = createHarness()
    const root = harness.control.bind("root_session", TARGET)
    const results = await Promise.allSettled([
      root.spawn({
        taskName: "same",
        message: "first",
        agentType: "general",
        forkTurns: "none",
      }),
      root.spawn({
        taskName: "same",
        message: "second",
        agentType: "general",
        forkTurns: "none",
      }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ])
    expect(harness.children).toHaveLength(1)
  })

  it("publishes launch failure only after the Session status becomes errored", async () => {
    const harness = createHarness()
    const root = harness.control.bind("root_session", TARGET)
    const child = await root.spawn({
      taskName: "failing",
      message: "fail",
      agentType: "general",
      forkTurns: "none",
    })
    harness.runs.get(child.agentId)?.[0]?.reject(new Error("launch failed"))

    await expect(root.wait(1_000)).resolves.toEqual([
      {
        agentId: child.agentId,
        path: child.path,
        status: { errored: "launch failed" },
      },
    ])
    await expect(root.list()).resolves.toMatchObject([
      { agentId: child.agentId, status: { errored: "launch failed" } },
    ])
  })

  it("rolls back a child whose spawn overlaps closing its tree", async () => {
    const createStarted = deferred<void>()
    const releaseCreate = deferred<void>()
    const harness = createHarness({ createStarted, releaseCreate })
    const root = harness.control.bind("root_session", TARGET)
    const spawning = root.spawn({
      taskName: "late",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    await createStarted.promise

    const closing = harness.control.closeAgent("root_session")
    releaseCreate.resolve()

    await expect(spawning).rejects.toMatchObject({ code: "agent_closed" })
    await expect(closing).resolves.toEqual(["root_session"])
    expect(harness.rolledBack).toEqual(["agent_1"])
    await expect(root.list()).resolves.toEqual([])
  })

  it("retries a failed completion delivery without rerunning the child", async () => {
    const harness = createHarness({ failDeliveryOnce: true })
    const root = harness.control.bind("root_session", TARGET)
    const child = await root.spawn({
      taskName: "worker",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    harness.runs.get(child.agentId)?.[0]?.resolve({
      type: "completed",
      text: "done",
    })

    await expect(root.wait(1_000)).resolves.toEqual([])
    expect(harness.backgroundErrors).toEqual([
      {
        error: expect.objectContaining({ message: "delivery failed" }),
        agentId: child.agentId,
        operation: "task-worker",
      },
    ])
    await expect(root.wait(1_000)).resolves.toEqual([
      expect.objectContaining({
        agentId: child.agentId,
        status: { completed: "done" },
      }),
    ])
    expect(harness.runRequests).toHaveLength(1)
    expect(harness.deliveryAttempts).toHaveLength(2)
    expect(harness.deliveryAttempts[0]?.messageId).toBe(
      harness.deliveryAttempts[1]?.messageId,
    )
  })

  it("fails close when a late child cannot be rolled back", async () => {
    const createStarted = deferred<void>()
    const releaseCreate = deferred<void>()
    const harness = createHarness({
      createStarted,
      releaseCreate,
      rollbackError: new Error("storage cleanup failed"),
    })
    const root = harness.control.bind("root_session", TARGET)
    const spawning = root.spawn({
      taskName: "orphan",
      message: "work",
      agentType: "general",
      forkTurns: "none",
    })
    await createStarted.promise
    const closing = harness.control.closeAgent("root_session")
    releaseCreate.resolve()

    await expect(spawning).rejects.toThrow("Failed to roll back late agent")
    await expect(closing).rejects.toThrow("Failed to roll back late agent")
  })
})

function createHarness(
  input: {
    readonly maxDepth?: number
    readonly maxConcurrentAgents?: number
    readonly ensureLoaded?: () => Promise<void>
    readonly onRunResolved?: () => void
    readonly createStarted?: ReturnType<typeof deferred<void>>
    readonly releaseCreate?: ReturnType<typeof deferred<void>>
    readonly failDeliveryOnce?: boolean
    readonly rollbackError?: Error
  } = {},
) {
  let nextId = 1
  const runs = new Map<
    string,
    Array<ReturnType<typeof deferred<AgentRunOutcome>>>
  >()
  const runRequests: Array<{
    readonly sessionId: string
    readonly message: string
    readonly target: typeof TARGET
  }> = []
  const statuses = new Map<
    string,
    import("../../src/core/session-io.ts").AgentStatus
  >()
  const interrupted: string[] = []
  const children: Array<Parameters<AgentControlAdapter["createChild"]>[0]> = []
  const deliveredMessages: Array<
    Parameters<AgentControlAdapter["deliverMessage"]>[0]
  > = []
  const rolledBack: string[] = []
  const deliveryAttempts: Array<
    Parameters<AgentControlAdapter["deliverMessage"]>[0]
  > = []
  const backgroundErrors: Array<{
    readonly error: unknown
    readonly agentId: string
    readonly operation: string
  }> = []
  let shouldFailDelivery = input.failDeliveryOnce ?? false
  const prefix: readonly ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "parent prefix" }] },
  ]
  const adapter: AgentControlAdapter = {
    async createChild(request) {
      children.push(request)
      const id = `agent_${String(nextId)}`
      nextId += 1
      statuses.set(id, "pending_init")
      input.createStarted?.resolve()
      await input.releaseCreate?.promise
      return id
    },
    runChild(request) {
      runRequests.push(request)
      statuses.set(request.sessionId, "running")
      const run = deferred<AgentRunOutcome>()
      const queued = runs.get(request.sessionId) ?? []
      queued.push(run)
      runs.set(request.sessionId, queued)
      return run.promise.then((outcome) => {
        statuses.set(
          request.sessionId,
          outcome.type === "completed"
            ? { completed: outcome.text }
            : outcome.type === "errored"
              ? { errored: outcome.error }
              : "interrupted",
        )
        input.onRunResolved?.()
        return outcome
      })
    },
    async ensureLoaded() {
      await input.ensureLoaded?.()
    },
    async getStatus(sessionId) {
      return statuses.get(sessionId) ?? "not_found"
    },
    async failChild(sessionId, message) {
      const status = { errored: message } as const
      statuses.set(sessionId, status)
      return status
    },
    async completionDeliveryId(sessionId) {
      return `agent_completion_${sessionId}_${String(runRequests.length)}`
    },
    async interruptChild(sessionId) {
      interrupted.push(sessionId)
    },
    async deliverMessage(request) {
      deliveryAttempts.push(request)
      if (shouldFailDelivery) {
        shouldFailDelivery = false
        throw new Error("delivery failed")
      }
      deliveredMessages.push(request)
    },
    async rollbackChild(sessionId) {
      if (input.rollbackError !== undefined) throw input.rollbackError
      rolledBack.push(sessionId)
      statuses.delete(sessionId)
    },
    captureForkContext(request: {
      readonly parentSessionId: string
      readonly forkTurns: ForkTurns
    }) {
      return request.forkTurns === "all"
        ? { sourceSessionId: request.parentSessionId, messages: prefix }
        : undefined
    },
  }
  return {
    control: createAgentControl({
      rootSessionId: "root_session",
      adapter,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.maxConcurrentAgents === undefined
        ? {}
        : { maxConcurrentAgents: input.maxConcurrentAgents }),
      onBackgroundError(error, agentId, operation) {
        backgroundErrors.push({ error, agentId, operation })
      },
    }),
    runs,
    runRequests,
    interrupted,
    children,
    deliveredMessages,
    rolledBack,
    deliveryAttempts,
    backgroundErrors,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}
