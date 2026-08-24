import { describe, expect, it } from "vitest"
import type { ExecutionEntry } from "../../src/gui/execution-view.ts"
import { presentTool } from "../../src/gui/tool-presentation.ts"
import type {
  JsonValue,
  ToolExecutionDescriptor,
} from "../../src/kernel/events.ts"
import {
  commandExecution,
  collaborationExecution,
  completeCollaborationExecution,
  completeCommandExecution,
  completeFileChangeExecution,
  completeFileReadExecution,
  completeFileSearchExecution,
  completeWebFetchExecution,
  completeWebSearchExecution,
  dynamicToolExecution,
  fileChangeExecution,
  fileReadExecution,
  fileSearchExecution,
  webFetchExecution,
  webSearchExecution,
} from "../../src/runtime/tools/execution-descriptors.ts"

type ToolEntry = Extract<ExecutionEntry, { readonly kind: "tool" }>

describe("tool presentation", () => {
  it("presents read ranges as a file preview target", () => {
    expect(
      presentTool(
        entry("read_file", {
          input: { path: "src/index.ts", offset: 10, limit: 20 },
          output: {
            path: "src/index.ts",
            truncated: true,
            range: { offset: 10, limit: 4 },
          },
          resultText: "10\tfirst\n11\tsecond",
        }),
      ),
    ).toMatchObject({
      verb: "Read",
      subject: "src/index.ts",
      meta: ["lines 10–13", "partial"],
      target: { kind: "file", path: "src/index.ts", line: 10 },
      detail: { kind: "file_excerpt", startLine: 10 },
    })
  })

  it("presents a structured directory read", () => {
    expect(
      presentTool(
        entry("read_file", {
          input: { path: "src" },
          output: {
            path: "src",
            kind: "directory",
            count: 2,
            entries: ["a.ts", "b.ts"],
            truncated: false,
          },
          resultText: "Listed 2 entries in src.\na.ts\nb.ts",
        }),
      ),
    ).toMatchObject({
      verb: "List",
      subject: "src",
      detail: {
        kind: "file_list",
        paths: ["src/a.ts", "src/b.ts"],
      },
    })
  })

  it("groups structured grep matches into clickable files", () => {
    expect(
      presentTool(
        entry("grep", {
          input: {
            pattern: "createWorkspaceSnapshotStore",
            path: "src",
            output_mode: "content",
          },
          output: {
            path: "src",
            count: 3,
            truncated: false,
            timedOut: false,
            outputMode: "content",
            locations: [
              { path: "src/a.ts", line: 7, text: "first" },
              { path: "src/a.ts", line: 12, text: "second" },
              { path: "src/b.ts", line: 4, text: "third" },
            ],
          },
          resultText:
            "Grep returned 3 results.\nsrc/a.ts:7:first\nsrc/a.ts:12:second\nsrc/b.ts:4:third",
        }),
      ),
    ).toMatchObject({
      verb: "Search",
      subject: "“createWorkspaceSnapshotStore” in src",
      meta: ["3 matches", "2 files"],
      detail: {
        kind: "file_matches",
        groups: [
          {
            path: "src/a.ts",
            matches: [
              { line: 7, text: "first" },
              { line: 12, text: "second" },
            ],
          },
          { path: "src/b.ts", matches: [{ line: 4, text: "third" }] },
        ],
      },
    })
  })

  it("prefers persisted search locations over text parsing", () => {
    expect(
      presentTool(
        entry("grep", {
          input: { pattern: "needle", output_mode: "content" },
          output: {
            count: 1,
            outputMode: "content",
            locations: [{ path: "src/real.ts", line: 42 }],
          },
          resultText: "Grep returned 1 result.\nlegacy-format-without-location",
        }),
      ),
    ).toMatchObject({
      detail: {
        kind: "file_matches",
        groups: [{ path: "src/real.ts", matches: [{ line: 42 }] }],
      },
    })
  })

  it("presents grep matches without line numbers", () => {
    expect(
      presentTool(
        entry("grep", {
          input: {
            pattern: "needle",
            output_mode: "content",
            "-n": false,
          },
          output: {
            path: ".",
            count: 2,
            truncated: false,
            timedOut: false,
            outputMode: "content",
            locations: [
              { path: "src/a.ts", text: "first" },
              { path: "src/a.ts", text: "second:with colon" },
            ],
          },
          resultText:
            "Grep returned 2 results.\nsrc/a.ts:first\nsrc/a.ts:second:with colon",
        }),
      ),
    ).toMatchObject({
      detail: {
        kind: "file_matches",
        groups: [
          {
            path: "src/a.ts",
            matches: [{ text: "first" }, { text: "second:with colon" }],
          },
        ],
      },
    })
  })

  it("pairs no-line grep text with persisted line targets", () => {
    expect(
      presentTool(
        entry("grep", {
          input: {
            pattern: "needle",
            output_mode: "content",
            "-n": false,
          },
          output: {
            count: 1,
            outputMode: "content",
            locations: [{ path: "src/a.ts", line: 7, text: "matched text" }],
          },
          resultText: "Grep returned 1 result.\nsrc/a.ts:matched text",
        }),
      ),
    ).toMatchObject({
      detail: {
        kind: "file_matches",
        groups: [
          {
            path: "src/a.ts",
            matches: [{ line: 7, text: "matched text" }],
          },
        ],
      },
    })
  })

  it("normalizes the model-facing count_matches alias", () => {
    expect(
      presentTool(
        entry("grep", {
          input: { pattern: "needle", output_mode: "count_matches" },
          output: {
            path: ".",
            count: 1,
            outputMode: "count",
            truncated: false,
            timedOut: false,
            locations: [{ path: "src/a.ts", count: 3 }],
          },
          resultText: "Grep returned 1 result.\nsrc/a.ts:3",
        }),
      ),
    ).toMatchObject({
      detail: { kind: "file_list", paths: ["src/a.ts"] },
    })
  })

  it("renders empty and failed searches as text instead of file links", () => {
    expect(
      presentTool(
        entry("glob", {
          input: { pattern: "*.missing" },
          resultText: "No files found.",
        }),
      ),
    ).toMatchObject({ detail: { kind: "text", text: "No files found." } })

    expect(
      presentTool(
        entry("grep", {
          input: { pattern: "needle" },
          state: "failed",
          resultError: true,
          resultText: "search_failed: ripgrep could not start.",
        }),
      ),
    ).toMatchObject({
      detail: {
        kind: "text",
        text: "search_failed: ripgrep could not start.",
      },
    })
  })

  it("turns structured glob output into a file list", () => {
    expect(
      presentTool(
        entry("glob", {
          input: { pattern: "src/**/*.test.ts" },
          output: {
            path: ".",
            count: 2,
            truncated: false,
            paths: ["src/a.test.ts", "src/b.test.ts"],
          },
          resultText: "Glob returned 2 files.\nsrc/a.test.ts\nsrc/b.test.ts",
        }),
      ),
    ).toMatchObject({
      verb: "Find",
      subject: "“src/**/*.test.ts”",
      meta: ["2 files"],
      detail: {
        kind: "file_list",
        paths: ["src/a.test.ts", "src/b.test.ts"],
      },
    })
  })

  it("uses structured glob paths when available", () => {
    expect(
      presentTool(
        entry("glob", {
          input: { pattern: "src/**/*.ts" },
          output: {
            count: 1,
            truncated: false,
            paths: ["src/real.ts"],
          },
          resultText: "Glob returned 1 file.\nlegacy-value",
        }),
      ),
    ).toMatchObject({
      detail: { kind: "file_list", paths: ["src/real.ts"] },
    })
  })

  it("summarizes diffs and command results without status badges", () => {
    expect(
      presentTool(
        entry("edit_file", {
          input: { path: "src/index.ts" },
          output: { path: "src/index.ts", created: false },
          diff: {
            text: "--- a/src/index.ts\n+++ b/src/index.ts\n-old\n+new\n+more",
            truncated: false,
          },
        }),
      ),
    ).toMatchObject({ meta: ["+2 −1"], detail: { kind: "diff" } })

    expect(
      presentTool(
        entry("run_command", {
          input: { command: "pnpm test" },
          commandResult: {
            exitCode: 0,
            signal: null,
            stdout: "ok",
            stderr: "",
            truncated: false,
            timedOut: false,
            durationMs: 1_240,
          },
        }),
      ),
    ).toMatchObject({ meta: ["exit 0", "1.2s"], detail: { kind: "command" } })
  })

  it("keeps every file in a multi-file change", () => {
    const base = entry("edit_file", {
      input: { path: "src/a.ts" },
      resultText: "Changed two files.",
    })

    expect(
      presentTool({
        ...base,
        execution: {
          ...base.execution,
          type: "file_change",
          request: {
            operation: "apply_patch",
            paths: ["src/a.ts", "src/b.ts"],
          },
          changes: [
            {
              path: "src/a.ts",
              kind: "update",
              diff: {
                format: "unified",
                text: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new",
                truncated: false,
              },
            },
            {
              path: "src/b.ts",
              kind: "add",
              diff: {
                format: "unified",
                text: "--- /dev/null\n+++ b/src/b.ts\n+new",
                truncated: false,
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      verb: "Change",
      subject: "2 files",
      meta: ["+2 −1"],
      detail: {
        kind: "file_changes",
        changes: [
          { path: "src/a.ts", kind: "update" },
          { path: "src/b.ts", kind: "add" },
        ],
      },
    })
  })

  it("presents a moved file with its destination as the navigation target", () => {
    const base = entry("edit_file", {
      input: { path: "src/old.ts" },
      resultText: "Moved file.",
    })

    expect(
      presentTool({
        ...base,
        execution: {
          ...base.execution,
          type: "file_change",
          request: { operation: "apply_patch", paths: ["src/old.ts"] },
          changes: [
            {
              path: "src/old.ts",
              kind: "update",
              movePath: "src/new.ts",
              diff: {
                format: "unified",
                text: "--- a/src/old.ts\n+++ b/src/new.ts",
                truncated: false,
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      subject: "src/old.ts → src/new.ts",
      target: { kind: "file", path: "src/new.ts" },
      detail: { kind: "diff", path: "src/new.ts" },
    })
  })

  it("keeps every receiver in a multi-agent collaboration", () => {
    const base = entry("spawn_agent", {
      input: { task_name: "review", message: "Review changes" },
      resultText: "Reviewers started.",
    })

    expect(
      presentTool({
        ...base,
        execution: {
          ...base.execution,
          type: "collaboration_tool_call",
          action: "spawn",
          description: "Review changes",
          receivers: [
            { sessionId: "session_a", path: "/root/review_a" },
            { sessionId: "session_b", path: "/root/review_b" },
          ],
        },
      }),
    ).toMatchObject({
      meta: ["2 agents"],
      detail: {
        kind: "collaboration",
        receivers: [
          { sessionId: "session_a", path: "/root/review_a" },
          { sessionId: "session_b", path: "/root/review_b" },
        ],
      },
    })
  })

  it("extracts web links and typed collaboration navigation", () => {
    expect(
      presentTool(
        entry("web_search", {
          input: { query: "Electron shell" },
          output: {
            links: [
              {
                title: "Electron shell",
                url: "https://electronjs.org/docs/latest/api/shell",
              },
              {
                title: "Security",
                url: "https://electronjs.org/docs/latest/tutorial/security",
              },
            ],
          },
          resultText:
            "1. Electron shell — https://electronjs.org/docs/latest/api/shell\n2. Security — https://electronjs.org/docs/latest/tutorial/security",
        }),
      ),
    ).toMatchObject({
      subject: "“Electron shell”",
      meta: ["2 results"],
      detail: {
        kind: "links",
        links: [
          {
            title: "Electron shell",
            url: "https://electronjs.org/docs/latest/api/shell",
          },
          {
            title: "Security",
            url: "https://electronjs.org/docs/latest/tutorial/security",
          },
        ],
      },
    })

    expect(
      presentTool(
        entry("spawn_agent", {
          input: { task_name: "inspect_auth", message: "Inspect auth" },
          output: { agentId: "session_child", path: "/root/inspect_auth" },
          resultText: "Found the validation path.",
        }),
      ),
    ).toMatchObject({
      verb: "Collaborate",
      target: { kind: "session", sessionId: "session_child" },
      detail: {
        kind: "collaboration",
        receivers: [{ sessionId: "session_child", path: "/root/inspect_auth" }],
      },
    })
  })
})

function entry(
  name: string,
  input: Partial<
    Omit<ToolEntry, "kind" | "toolCallId" | "turnId" | "execution">
  > & {
    readonly input?: JsonValue
    readonly diff?: { readonly text: string; readonly truncated: boolean }
    readonly commandResult?: unknown
  },
): ToolEntry {
  const {
    input: rawInput = {},
    diff,
    commandResult,
    output: rawOutput,
    ...rest
  } = input
  const output =
    commandResult ??
    (diff === undefined
      ? rawOutput
      : {
          ...(recordOf(rawOutput) ?? {}),
          diff: { format: "unified", ...diff },
        })
  const toolCallId = `tool_${name}`
  return {
    kind: "tool",
    toolCallId,
    turnId: "turn_1",
    execution: {
      ...executionDescriptor(name, rawInput, output),
      itemId: `item_${name}`,
      toolCallId,
      name,
      input: rawInput,
      requiresPermission: false,
    },
    state: "completed",
    ...(output === undefined ? {} : { output }),
    ...rest,
  }
}

function executionDescriptor(
  name: string,
  input: JsonValue,
  output: unknown,
): ToolExecutionDescriptor {
  const started = startedExecutionDescriptor(name, input)
  if (output === undefined) return started
  const value = output as JsonValue
  switch (started.type) {
    case "command_execution":
      return completeCommandExecution(started, value)
    case "file_change":
      return completeFileChangeExecution(started, value)
    case "file_read":
      return completeFileReadExecution(started, value)
    case "file_search":
      return completeFileSearchExecution(started, value)
    case "web_fetch":
      return completeWebFetchExecution(started, value)
    case "web_search":
      return completeWebSearchExecution(started, value)
    case "collaboration_tool_call":
      return completeCollaborationExecution(started, value)
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return started
  }
}

function startedExecutionDescriptor(
  name: string,
  input: JsonValue,
): ToolExecutionDescriptor {
  switch (name) {
    case "run_command":
      return commandExecution(input)
    case "edit_file":
      return fileChangeExecution("edit")(input)
    case "write_file":
      return fileChangeExecution("write")(input)
    case "read_file":
      return fileReadExecution(input)
    case "grep":
      return fileSearchExecution("grep")(input)
    case "glob":
      return fileSearchExecution("glob")(input)
    case "web_fetch":
      return webFetchExecution(input)
    case "web_search":
      return webSearchExecution(input)
    case "spawn_agent":
      return collaborationExecution("spawn")(input)
    default:
      return dynamicToolExecution()
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
