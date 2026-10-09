import { describe, expect, it, vi } from "vitest"
import {
  AgentControlError,
  createAgentControl,
  type BoundAgentControl,
} from "../../../src/runtime/agent-control.ts"
import type {
  JsonValue,
  ToolExecutionDescriptor,
} from "../../../src/kernel/index.ts"
import { createToolExecutionGate } from "../../../src/runtime/tool-execution-gate.ts"
import { createMultiAgentTools } from "../../../src/runtime/tools/multi-agent.ts"
import { canonicalToolName } from "../../../src/runtime/tools/tool-name.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../../../src/runtime/tools/types.ts"

describe("multi-agent tools", () => {
  it("cancels mailbox waits and releases tool admission for the next turn", async () => {
    vi.useFakeTimers()
    const agentControl = createAgentControl({
      rootSessionId: "root",
      adapter: {
        async createChild() {
          throw new Error("unused")
        },
        async runChild() {
          throw new Error("unused")
        },
        async ensureLoaded() {},
        async getStatus() {
          return "running"
        },
        async failChild() {
          return "interrupted"
        },
        async completionDeliveryId() {
          return "unused"
        },
        async interruptChild() {},
        async deliverMessage() {},
        async rollbackChild() {},
        captureForkContext() {
          return undefined
        },
      },
    })
    const gate = createToolExecutionGate()
    const controller = new AbortController()
    let outcome: "pending" | "resolved" | "aborted" = "pending"
    let nextTurnAdmitted = false
    try {
      const waiting = gate
        .reserve(false, controller.signal)
        .run(() =>
          requireTool("wait_agent").execute(
            { timeout_ms: 300_000 },
            {
              workspaceRoot: "/workspace",
              signal: controller.signal,
              agentControl: agentControl.bind("root", {
                provider: "faux",
                model: "scripted",
              }),
            },
          ),
        )
        .then(
          () => {
            outcome = "resolved"
          },
          (error: unknown) => {
            expect(error).toMatchObject({ name: "AbortError" })
            outcome = "aborted"
          },
        )
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      controller.abort()
      const nextTurn = gate
        .reserve(true, new AbortController().signal)
        .run(async () => {
          nextTurnAdmitted = true
        })
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome).toBe("aborted")
      expect(nextTurnAdmitted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      await Promise.all([waiting, nextTurn])
    } finally {
      await vi.runAllTimersAsync()
      await agentControl.close()
      vi.useRealTimers()
    }
  })

  it("registers the Codex V2 control surface with stable schemas", () => {
    const tools = createMultiAgentTools()
    expect(tools.map((tool) => canonicalToolName(tool.toolName))).toEqual([
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
    ])
    expect(
      tools.every(
        (tool) =>
          typeof tool.approvalRequirement !== "function" &&
          tool.approvalRequirement.kind === "none",
      ),
    ).toBe(true)
    expect(
      tools.find((tool) => canonicalToolName(tool.toolName) === "spawn_agent"),
    ).toMatchObject({
      effect: "observe",
      inputSchema: {
        required: ["task_name", "message"],
        properties: {
          agent_type: { enum: ["general", "explore"] },
          fork_turns: { type: "string", default: "none" },
        },
      },
    })
  })

  it("parses spawn defaults and delegates to the bound control", async () => {
    const spawn = vi.fn(async () => ({
      agentId: "agent_1",
      taskName: "survey",
      path: "/root/survey",
    }))
    const tool = requireTool("spawn_agent")
    const result = await tool.execute(
      { task_name: "survey", message: "inspect" },
      context(control({ spawn })),
    )

    expect(spawn).toHaveBeenCalledWith({
      taskName: "survey",
      message: "inspect",
      agentType: "general",
      forkTurns: "none",
    })
    expect(result).toMatchObject({
      ok: true,
      output: { agentId: "agent_1", path: "/root/survey" },
    })
    expect(
      completedExecution(
        tool,
        { task_name: "survey", message: "inspect" },
        result,
      ),
    ).toMatchObject({
      type: "collaboration_tool_call",
      action: "spawn",
      receivers: [{ sessionId: "agent_1", path: "/root/survey" }],
    })
  })

  it("keeps each collaboration Session paired with its task path", async () => {
    const tool = requireTool("wait_agent")
    const result = await tool.execute(
      {},
      context(
        control({
          wait: async () => ({
            reason: "status",
            updates: [
              { agentId: "session_1", path: "/root/one", status: "running" },
              {
                agentId: "session_2",
                path: "/root/two",
                status: { completed: "done" },
              },
            ],
          }),
        }),
      ),
    )

    expect(result).toMatchObject({
      ok: true,
    })
    expect(completedExecution(tool, {}, result)).toMatchObject({
      type: "collaboration_tool_call",
      receivers: [
        { sessionId: "session_1", path: "/root/one" },
        { sessionId: "session_2", path: "/root/two" },
      ],
    })
  })

  it("maps control policy failures to structured tool errors", async () => {
    const tool = requireTool("spawn_agent")
    const result = await tool.execute(
      { task_name: "nested", message: "delegate", fork_turns: "none" },
      context(
        control({
          spawn: async () => {
            throw new AgentControlError(
              "agent_depth_limit_reached",
              "complete the task yourself",
            )
          },
        }),
      ),
    )

    expect(result).toEqual({
      ok: false,
      code: "agent_depth_limit_reached",
      message: "complete the task yourself",
      content: "agent_depth_limit_reached: complete the task yourself",
    })
  })
})

function completedExecution(
  tool: RuntimeTool,
  input: JsonValue,
  result: ToolExecutionResult,
): ToolExecutionDescriptor {
  if (!result.ok || tool.describeExecution === undefined) {
    throw new Error("Expected a successful typed tool result.")
  }
  const started = tool.describeExecution(input)
  return tool.completeExecution?.(started, result.output, true) ?? started
}

function requireTool(name: string) {
  const tool = createMultiAgentTools().find(
    (candidate) => canonicalToolName(candidate.toolName) === name,
  )
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool
}

function context(agentControl: BoundAgentControl): ToolExecutionContext {
  return { workspaceRoot: process.cwd(), agentControl }
}

function control(
  overrides: Partial<BoundAgentControl> = {},
): BoundAgentControl {
  return {
    spawn: async () => ({
      agentId: "agent_default",
      taskName: "default",
      path: "/root/default",
    }),
    sendMessage: async () => ({
      agentId: "agent_default",
      path: "/root/default",
    }),
    followup: async () => ({ agentId: "agent_default", path: "/root/default" }),
    wait: async () => ({ reason: "timeout", updates: [] }),
    interrupt: async () => ({
      agentId: "agent_default",
      path: "/root/default",
      previousStatus: "running",
    }),
    list: async () => [],
    ...overrides,
  }
}
