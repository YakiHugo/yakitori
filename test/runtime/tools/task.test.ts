import { describe, expect, it } from "vitest"
import {
  createDefaultTools,
  createTaskTool,
  type SpawnSubagent,
  type ToolExecutionContext,
} from "../../../src/index.ts"

const NO_SPAWN: ToolExecutionContext = { workspaceRoot: process.cwd() }

function spawnContext(spawnSubagent: SpawnSubagent): ToolExecutionContext {
  return { workspaceRoot: process.cwd(), spawnSubagent }
}

describe("task tool", () => {
  it("is auto-allowed, opaque, and registered after web_search", () => {
    const tool = createTaskTool()
    expect(tool).toMatchObject({
      name: "task",
      autoAllow: true,
      effect: "opaque",
      inputSchema: {
        additionalProperties: false,
        required: ["description", "prompt"],
        properties: {
          agent: { type: "string", enum: ["general", "explore"] },
        },
      },
    })
    const names = createDefaultTools().map((entry) => entry.name)
    expect(names.indexOf("task")).toBe(names.indexOf("web_search") + 1)
    // The description carries the three usage rules the model must see.
    expect(tool.description).toContain("read_file")
    expect(tool.description).toContain("self-contained")
    expect(tool.description).toContain("not visible to the user")
  })

  it("rejects malformed input before spawning", async () => {
    const tool = createTaskTool()
    for (const input of [
      undefined,
      {},
      { description: "d" },
      { prompt: "p" },
      { description: "  ", prompt: "p" },
      { description: "d", prompt: "" },
      { description: "d", prompt: "p", agent: "writer" },
    ]) {
      await expect(tool.execute(input, NO_SPAWN)).resolves.toMatchObject({
        ok: false,
        code: "invalid_tool_input",
      })
    }
  })

  it("fails with subagents_unavailable without a spawnSubagent capability", async () => {
    const result = await createTaskTool().execute(
      { description: "d", prompt: "p" },
      NO_SPAWN,
    )
    expect(result).toMatchObject({ ok: false, code: "subagents_unavailable" })
  })

  it("defaults agent to general and returns the subagent's final text", async () => {
    const calls: unknown[] = []
    const result = await createTaskTool().execute(
      { description: "survey", prompt: "look around" },
      spawnContext(async (input) => {
        calls.push(input)
        return { ok: true, sessionId: "session_child", text: "findings" }
      }),
    )
    expect(calls).toEqual([
      { agent: "general", description: "survey", prompt: "look around" },
    ])
    expect(result).toMatchObject({
      ok: true,
      content: "findings",
      output: { agent: "general", sessionId: "session_child" },
    })
  })

  it("maps a subagent failure into a subagent_failed tool error", async () => {
    const result = await createTaskTool().execute(
      { description: "d", prompt: "p", agent: "explore" },
      spawnContext(async () => ({
        ok: false,
        sessionId: "session_child",
        error: "Subagent turn failed: model exploded.",
        partialText: "half an answer",
      })),
    )
    expect(result).toMatchObject({
      ok: false,
      code: "subagent_failed",
      message: "Subagent turn failed: model exploded.",
      output: {
        agent: "explore",
        sessionId: "session_child",
        partialText: "half an answer",
      },
    })
    if (!result.ok) {
      expect(result.content).toContain("model exploded")
      expect(result.content).toContain("half an answer")
    }
  })
})
