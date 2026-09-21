// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ToolCell } from "../../src/gui/components/cells/tool-cell.tsx"
import type {
  CommandResult,
  ExecutionEntry,
  ToolDiff,
} from "../../src/gui/execution-view.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import type {
  ImageAttachment,
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
  it("opens a single recipient trace without expanding the actual tool output", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn(async (_sessionId: string) => {})
    render(
      <ToolCell
        entry={collaborationEntry([
          { sessionId: "session_child", path: "/root/review" },
        ])}
        onOpenSession={onOpenSession}
      />,
    )

    expect(screen.queryByText("Review authentication changes")).toBeNull()
    expect(screen.getByText("review")).toBeTruthy()
    expect(screen.queryByText("/root/review")).toBeNull()
    expect(
      screen.queryByText("Agent accepted the task; child is working."),
    ).toBeNull()
    expect(screen.queryByText(/completed|success/i)).toBeNull()

    await user.click(
      screen.getByRole("button", { name: "View trace for /root/review" }),
    )

    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("session_child")
    expect(
      screen.queryByText("Agent accepted the task; child is working."),
    ).toBeNull()

    await user.click(screen.getByRole("button", { name: /Spawn agent review/ }))

    expect(screen.getByText("Review authentication changes")).toBeTruthy()
    expect(
      screen.getByText("Agent accepted the task; child is working."),
    ).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /View trace/ })).toHaveLength(
      1,
    )
  })

  it("keeps an agent message inside disclosure and shows the resolved recipient in its collapsed row", async () => {
    const user = userEvent.setup()
    const base = collaborationEntry([
      { sessionId: "session_child", path: "/root/stream_performance" },
    ])
    render(
      <ToolCell
        entry={{
          ...base,
          execution: {
            ...base.execution,
            type: "collaboration_tool_call",
            action: "send_message",
            input: {
              target: "session_child",
              message: "My telemetry tests pass. Please finish your changes.",
            },
            description: "My telemetry tests pass. Please finish your changes.",
            receivers: [
              { sessionId: "session_child", path: "/root/stream_performance" },
            ],
          },
        }}
      />,
    )
    expect(screen.getByText("stream_performance")).toBeTruthy()
    expect(screen.queryByText(/My telemetry tests pass/)).toBeNull()
    await user.click(
      screen.getByRole("button", { name: /Message agent stream_performance/ }),
    )
    expect(
      screen.getByText("My telemetry tests pass. Please finish your changes."),
    ).toBeTruthy()
  })

  it("opens each recorded recipient directly from a collapsed multi-agent card", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn(async (_sessionId: string) => {})
    render(
      <ToolCell
        entry={collaborationEntry([
          { sessionId: "session_a", path: "/root/review_a" },
          { sessionId: "session_b", path: "/root/review_b" },
        ])}
        onOpenSession={onOpenSession}
      />,
    )

    await user.click(
      screen.getByRole("button", { name: "View trace for /root/review_b" }),
    )
    await user.click(
      screen.getByRole("button", { name: "View trace for /root/review_a" }),
    )

    expect(onOpenSession.mock.calls).toEqual([["session_b"], ["session_a"]])
    expect(
      screen.queryByText("Agent accepted the task; child is working."),
    ).toBeNull()
  })

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
    expect(await screen.findByText(/No process was started/)).toBeTruthy()
    expect(screen.queryByText(/exit \d/)).toBeNull()
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

  it("opens itself when a running tool fails", async () => {
    const requested = toolEntry({
      kind: "tool",
      toolCallId: "tool_fail_mid_run",
      turnId: "turn_1",
      name: "run_command",
      executionType: "command_execution",
      summary: "Run command",
      input: { command: "example" },
      state: "requested",
    })
    const { rerender } = render(<ToolCell entry={requested} />)

    expect(screen.queryByText("$ example")).toBeNull()

    rerender(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_fail_mid_run",
          turnId: "turn_1",
          name: "run_command",
          executionType: "command_execution",
          summary: "Run command",
          input: { command: "example" },
          state: "failed",
          resultError: true,
          resultErrorMessage: "Command failed to start: spawn example ENOENT",
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

    expect(await screen.findByText("$ example")).toBeTruthy()
  })

  it("shows an interrupted summary and opens the detail", async () => {
    render(
      <ToolCell
        entry={toolEntry({
          kind: "tool",
          toolCallId: "tool_interrupted",
          turnId: "turn_1",
          name: "run_command",
          executionType: "command_execution",
          summary: "pnpm build",
          input: { command: "pnpm build" },
          state: "interrupted",
          resultText: "partial build output",
        })}
      />,
    )

    expect(screen.getByText("Interrupted")).toBeTruthy()
    expect(await screen.findByText(/partial build output/)).toBeTruthy()
  })

  it.each([
    { apiBase: undefined, expected: "http://api.test:4444/base" },
    {
      apiBase: "http://child.test:5555/trace/",
      expected: "http://child.test:5555/trace",
    },
  ])("renders image attachments using apiBase override $apiBase or the store", async ({
    apiBase,
    expected,
  }) => {
    const user = userEvent.setup()
    useAppStore.setState({ apiBase: "http://api.test:4444/base/" })
    const screenshot: ImageAttachment = {
      name: "screenshot.png",
      mediaType: "image/png",
      sizeBytes: 1_234,
      file: { rolloutId: "rollout_1", path: "captures/screenshot.png" },
    }
    render(
      <ToolCell
        apiBase={apiBase}
        entry={{
          ...toolEntry({
            kind: "tool",
            toolCallId: "tool_screenshot",
            turnId: "turn_1",
            name: "read_file",
            executionType: "file_read",
            summary: "src/index.ts",
            input: { path: "src/index.ts" },
            state: "completed",
            resultText: "file contents",
          }),
          attachments: [screenshot],
        }}
      />,
    )

    await user.click(
      screen.getByRole("button", { name: /Read src\/index\.ts/ }),
    )

    const image = await screen.findByRole("img", { name: "screenshot.png" })
    expect(image.getAttribute("src")).toBe(
      `${expected}/rollouts/rollout_1/assets/captures/screenshot.png`,
    )
  })
})

function collaborationEntry(
  receivers: ReadonlyArray<Readonly<{ sessionId: string; path: string }>>,
): ToolEntry {
  return {
    kind: "tool",
    toolCallId: "tool_spawn",
    turnId: "turn_1",
    state: "completed",
    resultText: "Agent accepted the task; child is working.",
    execution: {
      itemId: "item_spawn",
      toolCallId: "tool_spawn",
      name: "spawn_agent",
      input: {
        task_name: "unresolved_input_name",
        message: "Review authentication changes",
      },
      requiresPermission: false,
      type: "collaboration_tool_call",
      action: "spawn",
      description: "Review authentication changes",
      receivers,
    },
  }
}

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
