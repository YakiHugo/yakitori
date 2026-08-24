import type {
  ItemContent,
  JsonValue,
  KernelError,
  ToolExecutionDescriptor,
  ToolExecutionItem,
} from "./events.ts"
import { jsonValuesEqual } from "./json-equality.ts"

type CompletedFields = Readonly<{
  resultItemId?: string
  content?: ItemContent
  output?: JsonValue
  error?: KernelError
}>

export function executionDescriptor(
  item: ToolExecutionItem & CompletedFields,
): ToolExecutionDescriptor {
  const {
    itemId,
    toolCallId,
    name,
    input,
    requiresPermission,
    resultItemId,
    content,
    output,
    error,
    ...execution
  } = item
  void itemId
  void toolCallId
  void name
  void input
  void requiresPermission
  void resultItemId
  void content
  void output
  void error
  return execution
}

export function toolExecutionDescriptorsCompatible(
  started: ToolExecutionDescriptor,
  completed: ToolExecutionDescriptor,
): boolean {
  if (started.type !== completed.type) return false
  if (
    started.type === "collaboration_tool_call" &&
    completed.type === "collaboration_tool_call"
  ) {
    return (
      started.action === completed.action &&
      started.description === completed.description
    )
  }
  if (started.type === "file_change" && completed.type === "file_change") {
    return jsonValuesEqual(started.request, completed.request)
  }
  return jsonValuesEqual(executionRequest(started), executionRequest(completed))
}

function executionRequest(execution: ToolExecutionDescriptor): object {
  if (
    execution.type === "command_execution" ||
    execution.type === "file_read" ||
    execution.type === "file_search" ||
    execution.type === "web_fetch" ||
    execution.type === "web_search" ||
    execution.type === "mcp_tool_call"
  ) {
    const { result, ...request } = execution
    void result
    return request
  }
  return execution
}
