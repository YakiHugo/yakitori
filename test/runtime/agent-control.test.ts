import { describe, expect, it } from "vitest"
import {
  createAgentControl,
  type AgentControlAdapter,
  type AgentRunOutcome,
  type ForkTurns,
  type ModelMessage,
} from "../../src/index.ts"

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
    expect(root.list()).toMatchObject([
      { agentId: "agent_1", path: "/root/survey", status: "running" },
    ])
    expect(harness.children[0]?.forkedContext).toEqual({
      sourceSessionId: "root_session",
      messages: [
        { role: "user", content: [{ type: "text", text: "parent prefix" }] },
      ],
    })

    harness.runs.get("agent_1")?.resolve({
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
    expect(harness.control.takeMessages("root_session")).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("findings"),
          },
        ],
      },
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
    expect(harness.control.takeMessages(child.agentId)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("extra context"),
          },
        ],
      },
    ])

    await root.followup({ target: "worker", message: "next task" })
    expect(harness.followups).toEqual([
      { sessionId: child.agentId, message: "next task", target: TARGET },
    ])
    await expect(root.interrupt(child.agentId)).resolves.toBe("running")
    expect(harness.interrupted).toEqual([child.agentId])
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
})

function createHarness(
  input: {
    readonly maxDepth?: number
    readonly maxConcurrentAgents?: number
  } = {},
) {
  let nextId = 1
  const runs = new Map<string, ReturnType<typeof deferred<AgentRunOutcome>>>()
  const followups: Array<{
    readonly sessionId: string
    readonly message: string
    readonly target: typeof TARGET
  }> = []
  const interrupted: string[] = []
  const children: Array<Parameters<AgentControlAdapter["createChild"]>[0]> = []
  const prefix: readonly ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "parent prefix" }] },
  ]
  const adapter: AgentControlAdapter = {
    async createChild(request) {
      children.push(request)
      const id = `agent_${String(nextId)}`
      nextId += 1
      runs.set(id, deferred())
      return id
    },
    runChild(sessionId) {
      const run = runs.get(sessionId)
      if (run === undefined) throw new Error(`missing run ${sessionId}`)
      return run.promise
    },
    async submitFollowup(request) {
      followups.push(request)
    },
    async interruptChild(sessionId) {
      interrupted.push(sessionId)
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
      adapter,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.maxConcurrentAgents === undefined
        ? {}
        : { maxConcurrentAgents: input.maxConcurrentAgents }),
    }),
    runs,
    followups,
    interrupted,
    children,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
