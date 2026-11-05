import { describe, expect, it } from "vitest"
import {
  groupConversationActivity,
  summarizeToolBatch,
} from "../../src/gui/conversation-activity.ts"
import type { ExecutionEntry } from "../../src/gui/execution-view.ts"
import type { ToolExecutionDescriptor } from "../../src/protocol/events.ts"
import { inputParts } from "../gui/input-fixtures.ts"

type ToolEntry = Extract<ExecutionEntry, { kind: "tool" }>
const at = "2026-11-05T00:00:00Z"

function tool(
  id: string,
  descriptor: ToolExecutionDescriptor = { type: "file_read", path: "same.txt" },
  name = id,
): ToolEntry {
  return {
    kind: "tool",
    toolCallId: id,
    turnId: "turn_1",
    execution: {
      ...descriptor,
      itemId: `item_${id}`,
      toolCallId: id,
      name,
      input: {},
      requiresPermission: false,
    },
    state: "completed",
  }
}

describe("conversation activity", () => {
  it.each([
    "shared",
    "distinct",
    "absent",
  ] as const)("organizes the same visible sequence with %s model-call identities", (identity) => {
    const callId = (index: number) =>
      identity === "absent"
        ? undefined
        : identity === "shared"
          ? "call_shared"
          : `call_${index}`
    const thoughtCallId = callId(0)
    const thought: ExecutionEntry = {
      kind: "reasoning",
      itemId: "thought",
      turnId: "turn_1",
      text: "Inspecting the files.",
      status: "completed",
      at,
      ...(thoughtCallId === undefined
        ? {}
        : { source: { callId: thoughtCallId, itemId: "thought" } }),
    }
    const reads = ["read_one", "read_two"].map((id, index) => {
      const entry = tool(id)
      const sourceCallId = callId(index + 1)
      return {
        ...entry,
        execution: {
          ...entry.execution,
          ...(sourceCallId === undefined ? {} : { modelCallId: sourceCallId }),
        },
      }
    })
    const narrationCallId = callId(3)
    const narration: ExecutionEntry = {
      kind: "assistant",
      itemId: "narration",
      turnId: "turn_1",
      text: "I will run the checks.",
      status: "completed",
      at,
      ...(narrationCallId === undefined
        ? {}
        : { source: { callId: narrationCallId, itemId: "narration" } }),
    }
    const command = tool("command", {
      type: "command_execution",
      command: "pnpm check",
    })
    expect(
      groupConversationActivity([thought, ...reads, narration, command]),
    ).toEqual([
      { kind: "batch", id: expect.any(String), entries: [thought, ...reads] },
      { kind: "entry", entry: narration },
      { kind: "batch", id: expect.any(String), entries: [command] },
    ])
  })

  const boundaries: { label: string; entry: ExecutionEntry }[] = [
    {
      label: "narration",
      entry: {
        kind: "assistant",
        itemId: "narration",
        turnId: "turn_1",
        text: "Continuing the review.",
        status: "completed",
        at,
      },
    },
    {
      label: "collaboration",
      entry: tool("spawn", {
        type: "collaboration_tool_call",
        action: "spawn",
        description: "Review the result",
        receivers: [],
      }),
    },
    {
      label: "plan",
      entry: tool("plan", { type: "dynamic_tool_call" }, "update_plan"),
    },
    {
      label: "questions",
      entry: tool(
        "questions",
        { type: "dynamic_tool_call" },
        "request_user_input_async",
      ),
    },
    {
      label: "permission",
      entry: {
        kind: "permission",
        permissionRequestId: "permission_1",
        turnId: "turn_1",
        toolCallId: "after",
        action: "Write file",
        state: "requested",
      },
    },
    {
      label: "user input",
      entry: {
        kind: "user_input",
        inputId: "input_followup",
        text: "Follow up",
        content: inputParts("Follow up"),
        at,
      },
    },
  ]
  it.each(boundaries)("ends a tool batch at $label", ({ entry }) => {
    const before = tool("before")
    const after = tool("after")
    expect(groupConversationActivity([before, entry, after])).toEqual([
      { kind: "batch", id: expect.any(String), entries: [before] },
      { kind: "entry", entry },
      { kind: "batch", id: expect.any(String), entries: [after] },
    ])
  })

  it("keeps raw reasoning and tool calls in their original batch order", () => {
    const first: Extract<ExecutionEntry, { kind: "reasoning" }> = {
      kind: "reasoning",
      itemId: "thought_one",
      turnId: "turn_1",
      text: "Compare the files before choosing a change.",
      status: "completed",
      at,
    }
    const second = {
      ...first,
      itemId: "thought_two",
      text: "Check the result.",
    }
    const sequence = [first, tool("first"), second, tool("second")]
    expect(groupConversationActivity(sequence)).toEqual([
      { kind: "batch", id: expect.any(String), entries: sequence },
    ])
    expect(groupConversationActivity([first, second])).toEqual([
      { kind: "batch", id: expect.any(String), entries: [first, second] },
    ])
  })

  it("keeps the first batch identity when more calls arrive and results complete", () => {
    const first = { ...tool("first"), state: "requested" }
    const second = tool("second")
    const initial = groupConversationActivity([first])[0]
    const completed = groupConversationActivity([
      { ...first, state: "completed" },
      second,
    ])[0]
    if (initial?.kind !== "batch" || completed?.kind !== "batch")
      throw new Error("Expected activity batches")
    expect(completed.id).toBe(initial.id)
    expect(completed.entries).toEqual([
      { ...first, state: "completed" },
      second,
    ])
  })

  it("counts repeated calls and keeps action categories in first-seen order", () => {
    const calls = [
      tool("command", { type: "command_execution", command: "pnpm check" }),
      tool("read_one"),
      tool("read_two"),
      tool("grep", {
        type: "file_search",
        operation: "grep",
        pattern: "text",
        lineNumbers: true,
      }),
      tool("glob", {
        type: "file_search",
        operation: "glob",
        pattern: "*.ts",
        lineNumbers: true,
      }),
      tool("edit", {
        type: "file_change",
        request: { operation: "edit", paths: ["same.txt"] },
        changes: [],
      }),
      tool("web_search", { type: "web_search", query: "documentation" }),
      tool("fetch", { type: "web_fetch", url: "https://example.com/" }),
      tool("mcp", {
        type: "mcp_tool_call",
        server: "files",
        tool: "read",
        arguments: {},
      }),
      tool("dynamic", { type: "dynamic_tool_call" }),
    ]
    expect(summarizeToolBatch(calls)).toBe(
      "1 command · 2 reads · 2 searches · 1 edit · 1 web search · 1 page fetch · 1 MCP call · 1 tool call",
    )
    expect(groupConversationActivity(calls)).toEqual([
      { kind: "batch", id: expect.any(String), entries: calls },
    ])
  })
})
