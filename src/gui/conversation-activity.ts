import { type ExecutionEntry, executionEntryKey } from "./execution-view.ts"

type ToolEntry = Extract<ExecutionEntry, { kind: "tool" }>
export type ActivityBatchEntry = Extract<
  ExecutionEntry,
  { kind: "reasoning" | "tool" }
>

export type ConversationActivity =
  | Readonly<{ kind: "entry"; entry: ExecutionEntry }>
  | Readonly<{
      kind: "batch"
      id: string
      entries: readonly [ActivityBatchEntry, ...ActivityBatchEntry[]]
    }>

// A model request is a transport boundary. Reader-visible prose, interactions
// and collaboration records delimit activity; raw reasoning stays inside it.
export function groupConversationActivity(
  entries: readonly ExecutionEntry[],
): readonly ConversationActivity[] {
  const activity: ConversationActivity[] = []
  let batch: ActivityBatchEntry[] = []
  const flushBatch = () => {
    const [first, ...rest] = batch
    if (first !== undefined)
      activity.push({
        kind: "batch",
        id: executionEntryKey(first),
        entries: [first, ...rest],
      })
    batch = []
  }
  for (const entry of entries) {
    if (
      entry.kind === "reasoning" ||
      (entry.kind === "tool" &&
        entry.execution.type !== "collaboration_tool_call" &&
        entry.execution.name !== "request_user_input_async" &&
        entry.execution.name !== "update_plan")
    ) {
      batch.push(entry)
      continue
    }
    flushBatch()
    activity.push({ kind: "entry", entry })
  }
  flushBatch()
  return activity
}

export function summarizeToolBatch(entries: readonly ToolEntry[]): string {
  const counts = new Map<ToolEntry["execution"]["type"], number>()
  for (const entry of entries) {
    const type = entry.execution.type
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  // Counts describe calls, not distinct paths: rereading a file is still a
  // separate action whose result must remain available in chronological order.
  return [...counts]
    .map(([type, count]) => {
      const labels = {
        file_read: ["read", "reads"],
        file_search: ["search", "searches"],
        file_change: ["edit", "edits"],
        command_execution: ["command", "commands"],
        web_search: ["web search", "web searches"],
        web_fetch: ["page fetch", "page fetches"],
        mcp_tool_call: ["MCP call", "MCP calls"],
        dynamic_tool_call: ["tool call", "tool calls"],
        collaboration_tool_call: ["collaboration call", "collaboration calls"],
      }[type]
      return `${count} ${count === 1 ? labels[0] : labels[1]}`
    })
    .join(" · ")
}
