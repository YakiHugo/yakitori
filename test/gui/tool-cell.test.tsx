// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { ToolCell } from "../../src/gui/components/cells/tool-cell.tsx"
import type {
  CommandResult,
  ExecutionEntry,
  ToolDiff,
} from "../../src/gui/execution-view.ts"
import type {
  JsonValue,
  ToolExecutionDescriptor,
} from "../../src/kernel/events.ts"
import {
  commandExecution,
  completeCommandExecution,
  completeFileChangeExecution,
  completeFileReadExecution,
  completeFileSearchExecution,
  fileChangeExecution,
  fileReadExecution,
  fileSearchExecution,
} from "../../src/runtime/tools/execution-descriptors.ts"

type ToolEntry = Extract<ExecutionEntry, { readonly kind: "tool" }>
type LegacyToolEntry = Omit<ToolEntry, "execution"> & {
  readonly name: string
  readonly executionType: string
  readonly summary: string
  readonly input: JsonValue
  readonly diff?: ToolDiff
  readonly commandResult?: CommandResult
}

afterEach(() => {
  cleanup()
})

describe("tool cell", () => {
  it("collapses to one row and expands to show the useful result", async () => {
    const user = userEvent.setup()
    render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_1",
          turnId: "turn_1",
          name: "read_file",
          executionType: "file_read",
          summary: "src/index.ts",
          input: { path: "src/index.ts" },
          state: "completed",
          resultText: "file contents",
        })}
      />,
    )

    expect(screen.queryByText("file contents")).toBeNull()
    expect(screen.queryByText(/"path"/)).toBeNull()

    await user.click(
      screen.getByRole("button", { name: /Read src\/index\.ts/ }),
    )

    expect(await screen.findByText("file contents")).toBeTruthy()
    expect(screen.queryByText(/"path"/)).toBeNull()
  })

  it("renders run_command entries as a terminal card when expanded", async () => {
    const user = userEvent.setup()
    render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_2",
          turnId: "turn_1",
          name: "run_command",
          executionType: "command_execution",
          summary: "pnpm test",
          input: { command: "pnpm test" },
          state: "completed",
          resultText: "all green",
        })}
      />,
    )

    expect(screen.queryByText(/\$ pnpm test/)).toBeNull()

    await user.click(screen.getByRole("button", { name: /Run pnpm test/ }))

    expect(await screen.findByText(/\$ pnpm test/)).toBeTruthy()
    expect(screen.getByText(/all green/)).toBeTruthy()
  })

  it("renders a structured command result with exit status and stderr", async () => {
    const user = userEvent.setup()
    render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_3",
          turnId: "turn_1",
          name: "run_command",
          executionType: "command_execution",
          summary: "pnpm lint",
          input: { command: "pnpm lint" },
          state: "completed",
          resultText: "lint failed",
          commandResult: {
            exitCode: 1,
            signal: null,
            stdout: "checking…",
            stderr: "2 errors",
            truncated: false,
            timedOut: false,
            durationMs: 1_240,
            cwd: "packages/gui",
            shell: "/bin/zsh",
          },
        })}
      />,
    )

    await user.click(screen.getByRole("button", { name: /Run pnpm lint/ }))

    expect(await screen.findByText(/\$ pnpm lint/)).toBeTruthy()
    expect(screen.getByText(/checking…/)).toBeTruthy()
    expect(screen.getByText(/\[stderr\]/)).toBeTruthy()
    expect(screen.getByText("exit 1")).toBeTruthy()
    expect(screen.getByText("1.2s")).toBeTruthy()
    expect(screen.getByText("packages/gui")).toBeTruthy()
  })

  it("renders blocked commands as failed without implying a process started", async () => {
    render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_blocked",
          turnId: "turn_1",
          name: "run_command",
          executionType: "command_execution",
          summary: "Remove root",
          input: { command: "rm -rf /", description: "Remove root" },
          state: "failed",
          resultError: true,
          resultErrorMessage:
            "Command blocked by catastrophic-command fuse (rm_root). No process was started.",
          resultText:
            "Command blocked by catastrophic-command fuse (rm_root). No process was started.",
          commandResult: {
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            truncated: false,
            timedOut: false,
            durationMs: 0,
            cwd: ".",
            shell: "/bin/zsh",
            blocked: { rule: "rm_root" },
          },
        })}
      />,
    )

    // Failed tools open themselves so the reason is not hidden.
    expect(await screen.findAllByText(/blocked/)).toHaveLength(3)
    expect(screen.getByText(/No process was started/)).toBeTruthy()
    expect(screen.getByText(".")).toBeTruthy()
  })

  it("renders structured command execution errors", async () => {
    render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_spawn_error",
          turnId: "turn_1",
          name: "run_command",
          executionType: "command_execution",
          summary: "Run command",
          input: { command: "example" },
          state: "failed",
          resultError: true,
          resultErrorMessage: "Command failed to start: spawn example ENOENT",
          resultText: "Partial command output",
          commandResult: {
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            truncated: false,
            timedOut: false,
            cwd: ".",
            shell: "/bin/zsh",
          },
        })}
      />,
    )

    // Failed tools open themselves so the reason is not hidden.
    expect(
      await screen.findAllByText(
        "Command failed to start: spawn example ENOENT",
      ),
    ).toHaveLength(2)
  })

  it("renders a diff view instead of raw input for edit_file results", async () => {
    const user = userEvent.setup()
    render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_4",
          turnId: "turn_1",
          name: "edit_file",
          executionType: "file_change",
          summary: "src/index.ts",
          input: { path: "src/index.ts", oldString: "old", newString: "new" },
          state: "completed",
          resultText: "edited src/index.ts",
          diff: {
            text: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
            truncated: false,
          },
        })}
      />,
    )

    await user.click(
      screen.getByRole("button", { name: /Edit src\/index\.ts/ }),
    )

    expect(await screen.findByText("-old")).toBeTruthy()
    expect(screen.getByText("+new")).toBeTruthy()
    expect(screen.queryByText(/"oldString"/)).toBeNull()
  })

  it("renders both paths for a moved file", async () => {
    const user = userEvent.setup()
    const base = toolEntry({
      kind: "tool",
      toolCallId: "tool_move",
      turnId: "turn_1",
      name: "edit_file",
      executionType: "file_change",
      summary: "2 files",
      input: { path: "src/old.ts" },
      state: "completed",
      resultText: "Moved file.",
    })
    render(
      <ToolCell
        entry={{
          ...base,
          execution: {
            ...base.execution,
            type: "file_change",
            request: {
              operation: "apply_patch",
              paths: ["src/old.ts", "src/other.ts"],
            },
            changes: [
              {
                path: "src/old.ts",
                kind: "update",
                movePath: "src/new.ts",
              },
              { path: "src/other.ts", kind: "update" },
            ],
          },
        }}
      />,
    )

    await user.click(screen.getByRole("button", { name: /Change 2 files/ }))

    expect(await screen.findByText("src/old.ts")).toBeTruthy()
    expect(screen.getByText("src/new.ts")).toBeTruthy()
    expect(screen.getByText("→")).toBeTruthy()
  })

  it("uses a text shimmer instead of a status badge while running", () => {
    render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_running",
          turnId: "turn_1",
          name: "grep",
          executionType: "search",
          summary: "src",
          input: { pattern: "needle", path: "src" },
          state: "requested",
        })}
      />,
    )

    expect(screen.getByText("Searching").className).toContain(
      "tool-running-label",
    )
    expect(screen.queryByText("requested")).toBeNull()
    expect(screen.queryByText("completed")).toBeNull()
  })

  it("defaults running tools closed and preserves an explicit expansion on completion", async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_replayed",
          turnId: "turn_1",
          name: "read_file",
          executionType: "file_read",
          summary: "src/index.ts",
          input: { path: "src/index.ts" },
          state: "requested",
        })}
      />,
    )

    expect(screen.queryByText("Waiting for a result…")).toBeNull()

    await user.click(
      screen.getByRole("button", { name: /Reading src\/index\.ts/ }),
    )

    expect(screen.getByText("Waiting for a result…")).toBeTruthy()

    rerender(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_replayed",
          turnId: "turn_1",
          name: "read_file",
          executionType: "file_read",
          summary: "src/index.ts",
          input: { path: "src/index.ts" },
          state: "completed",
          resultText: "file contents",
        })}
      />,
    )

    expect(await screen.findByText("Read")).toBeTruthy()
    expect(screen.getByText("file contents")).toBeTruthy()
  })
})

function toolEntry(input: LegacyToolEntry): ToolEntry {
  const {
    name,
    executionType: _,
    summary: _summary,
    input: rawInput,
    diff,
    commandResult,
    output: rawOutput,
    ...entry
  } = input
  const output =
    commandResult ??
    (diff === undefined
      ? rawOutput
      : {
          ...(recordOf(rawOutput) ?? {}),
          diff: { format: "unified", ...diff },
        })
  const startedExecution = (() => {
    if (name === "run_command") return commandExecution(rawInput)
    if (name === "edit_file") {
      return fileChangeExecution("edit")(rawInput)
    }
    if (name === "grep") return fileSearchExecution("grep")(rawInput)
    return fileReadExecution(rawInput)
  })()
  const execution =
    output === undefined
      ? startedExecution
      : completeTestExecution(startedExecution, output as JsonValue)
  return {
    ...entry,
    execution: {
      ...execution,
      itemId: `item_${input.toolCallId}`,
      toolCallId: input.toolCallId,
      name,
      input: rawInput,
      requiresPermission: false,
    },
    ...(output === undefined ? {} : { output }),
  }
}

function completeTestExecution(
  started: ToolExecutionDescriptor,
  output: JsonValue,
): ToolExecutionDescriptor {
  switch (started.type) {
    case "command_execution":
      return completeCommandExecution(started, output)
    case "file_change":
      return completeFileChangeExecution(started, output)
    case "file_search":
      return completeFileSearchExecution(started, output)
    case "file_read":
      return completeFileReadExecution(started, output)
    case "web_fetch":
    case "web_search":
    case "collaboration_tool_call":
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return started
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
