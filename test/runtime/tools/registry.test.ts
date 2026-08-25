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

  it("keeps execution presentation separate from approval requirements", async () => {
    const registry = createToolRegistry()
    const router = registry.finalize(
      new Set(registry.definitions().map((definition) => definition.name)),
    )

    await expect(
      router.approvalRequirement(
        "read_file",
        { path: "README.md" },
        { workspaceRoot: "/workspace" },
      ),
    ).resolves.toEqual({ kind: "none" })
    await expect(
      router.approvalRequirement(
        "write_file",
        { path: "src/a.ts", content: "value" },
        { workspaceRoot: "/workspace" },
      ),
    ).resolves.toMatchObject({
      kind: "approval",
      action: "file_change",
      subject: "src/a.ts",
    })
    await expect(
      router.approvalRequirement(
        "run_command",
        { command: "git status" },
        { workspaceRoot: process.cwd() },
      ),
    ).resolves.toMatchObject({
      kind: "approval",
      action: "command_execution",
      subject: "git status",
      reason: expect.stringContaining(process.cwd()),
    })

    const requirements = await Promise.all(
      router.definitions.map(async (definition) => {
        const requirement = await router.approvalRequirement(
          definition.name,
          approvalInput(definition.name),
          { workspaceRoot: process.cwd() },
        )
        return [
          definition.name,
          requirement.kind === "none" ? "none" : requirement.action,
        ] as const
      }),
    )
    expect(Object.fromEntries(requirements)).toEqual({
      read_file: "none",
      grep: "none",
      glob: "none",
      edit_file: "file_change",
      write_file: "file_change",
      run_command: "command_execution",
      web_fetch: "none",
      web_search: "none",
      spawn_agent: "none",
      send_message: "none",
      followup_task: "none",
      wait_agent: "none",
      interrupt_agent: "none",
      list_agents: "none",
    })

    expect(
      router.describeExecution("run_command", { command: "git status" }),
    ).toMatchObject({ type: "command_execution", command: "git status" })
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
    approvalRequirement: { kind: "none" },
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

function approvalInput(name: string) {
  if (name === "run_command") return { command: "git status" }
  if (name === "write_file") return { path: "a.txt", content: "value" }
  if (name === "edit_file") {
    return { path: "a.txt", oldString: "old", newString: "new" }
  }
  return {}
}
