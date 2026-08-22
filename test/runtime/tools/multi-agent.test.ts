import { describe, expect, it, vi } from "vitest"
import {
  AgentControlError,
  createMultiAgentTools,
  type BoundAgentControl,
  type ToolExecutionContext,
} from "../../../src/index.ts"

describe("multi-agent tools", () => {
  it("registers the Codex V2 control surface with stable schemas", () => {
    const tools = createMultiAgentTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
    ])
    expect(tools.every((tool) => tool.autoAllow)).toBe(true)
    expect(tools.find((tool) => tool.name === "spawn_agent")).toMatchObject({
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

function requireTool(name: string) {
  const tool = createMultiAgentTools().find(
    (candidate) => candidate.name === name,
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
    sendMessage: async () => undefined,
    followup: async () => undefined,
    wait: async () => [],
    interrupt: async () => "running",
    list: () => [],
    ...overrides,
  }
}
