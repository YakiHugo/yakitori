import { describe, expect, it } from "vitest"
import { createToolRegistry } from "../../../src/runtime/tools/registry.ts"
import type { RuntimeTool } from "../../../src/runtime/tools/types.ts"

describe("finalized tool router", () => {
  it("advertises and dispatches the same enabled tool set", async () => {
    const registry = createToolRegistry([tool("read_file"), tool("grep")])
    const router = registry.finalize(new Set(["grep"]))

    expect(router.definitions.map((definition) => definition.name)).toEqual([
      "grep",
    ])
    expect(router.get("read_file")).toBeUndefined()
    await expect(
      router.execute("read_file", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({
      ok: false,
      code: "unknown_tool",
      message: "Unknown or disabled tool: read_file",
    })
    await expect(
      router.execute("grep", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({ ok: true, output: { name: "grep" } })
  })

  it("rejects duplicate tool names before a Step is finalized", () => {
    expect(() => createToolRegistry([tool("grep"), tool("grep")])).toThrow(
      "Duplicate tool name: grep",
    )
  })

  it("lets the owning tool project its completed durable execution", () => {
    const registry = createToolRegistry([
      {
        ...tool("grep"),
        completeExecution(started, output) {
          return {
            ...started,
            type: "file_search",
            operation: "grep",
            pattern: "needle",
            lineNumbers: true,
            result: {
              path: ".",
              outputMode: "content",
              count: 1,
              truncated: false,
              timedOut: false,
              matches: [{ path: "src/a.ts", line: 4, text: String(output) }],
            },
          }
        },
      },
    ])
    const router = registry.finalize(new Set(["grep"]))

    expect(
      router.completeExecution(
        "grep",
        {
          type: "file_search",
          operation: "grep",
          pattern: "needle",
          lineNumbers: true,
        },
        "matched",
        true,
      ),
    ).toMatchObject({
      result: {
        matches: [{ path: "src/a.ts", line: 4, text: "matched" }],
      },
    })
  })
})

function tool(name: string): RuntimeTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    autoAllow: true,
    effect: "observe",
    async execute() {
      return {
        ok: true,
        output: { name },
        content: name,
      }
    },
  }
}
