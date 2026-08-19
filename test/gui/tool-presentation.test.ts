import { describe, expect, it } from "vitest"
import type { ExecutionEntry } from "../../src/gui/execution-view.ts"
import { presentTool } from "../../src/gui/tool-presentation.ts"

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

  it("recognizes historical directory reads without structured output", () => {
    expect(
      presentTool(
        entry("read_file", {
          input: { path: "src" },
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

  it("groups historical grep text into clickable file matches", () => {
    expect(
      presentTool(
        entry("grep", {
          input: {
            pattern: "createWorkspaceSnapshotStore",
            path: "src",
            output_mode: "content",
          },
          output: { count: 3, truncated: false, outputMode: "content" },
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

  it("restores grep content when historical results omit line numbers", () => {
    expect(
      presentTool(
        entry("grep", {
          input: {
            pattern: "needle",
            output_mode: "content",
            "-n": false,
          },
          output: { count: 2, outputMode: "content" },
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
            locations: [{ path: "src/a.ts", line: 7 }],
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

  it("normalizes the historical count_matches alias", () => {
    expect(
      presentTool(
        entry("grep", {
          input: { pattern: "needle", output_mode: "count_matches" },
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

  it("turns historical glob output into a file list", () => {
    expect(
      presentTool(
        entry("glob", {
          input: { pattern: "src/**/*.test.ts" },
          output: { count: 2, truncated: false },
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

  it("extracts web links and child task navigation from old results", () => {
    expect(
      presentTool(
        entry("web_search", {
          input: { query: "Electron shell" },
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
        entry("task", {
          input: { description: "Inspect auth", agent: "explore" },
          output: { sessionId: "session_child", agent: "explore" },
          resultText: "Found the validation path.",
        }),
      ),
    ).toMatchObject({
      verb: "Delegate",
      target: { kind: "session", sessionId: "session_child" },
      detail: { kind: "task", sessionId: "session_child" },
    })
  })
})

function entry(
  name: string,
  input: Partial<Omit<ToolEntry, "kind" | "toolCallId" | "turnId" | "name">>,
): ToolEntry {
  return {
    kind: "tool",
    toolCallId: `tool_${name}`,
    turnId: "turn_1",
    name,
    summary: name,
    input: {},
    state: "completed",
    ...input,
  }
}
