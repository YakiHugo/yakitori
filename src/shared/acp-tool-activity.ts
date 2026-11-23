import { createTwoFilesPatch } from "diff"
import type { FileChange, ToolExecutionDescriptor } from "../protocol/events.ts"
import type { ExecutionEntry } from "../protocol/execution-view.ts"
import { isJsonValue } from "../protocol/json.ts"
import { acpBitmap, acpRecord, acpString } from "./acp-message-content.ts"

export type AcpToolEntry = Extract<ExecutionEntry, { kind: "tool" }>

// Bound the work of rendering a diff supplied by an external process.
const diffEditSafetyLimit = 2_000

export function projectAcpTool(
  wire: Record<string, unknown>,
  toolCallId: string,
  turnId: string,
  requiresPermission: boolean,
): AcpToolEntry {
  const input = acpRecord(wire.rawInput)
  const title = acpString(wire.title)
  const locations = new Map<string, { path: string; line?: number }>()
  for (const entry of Array.isArray(wire.locations) ? wire.locations : []) {
    const { path, line } = acpRecord(entry)
    if (typeof path !== "string" || !path.trim() || path.includes("\0"))
      continue
    const target =
      typeof line === "number" &&
      Number.isInteger(line) &&
      line > 0 &&
      line <= 0xffffffff
        ? { path, line }
        : { path }
    locations.set(JSON.stringify(target), target)
  }
  const location = locations.values().next().value
  const path = acpString(location?.path ?? input.path)
  const line = location?.line
  const parts = Array.isArray(wire.content) ? wire.content.map(acpRecord) : []
  const images = parts.flatMap((part) => {
    if (part.type !== "content") return []
    const content = acpRecord(part.content)
    const image =
      content.type === "image"
        ? acpBitmap(content.mimeType, content.data)
        : undefined
    return image === undefined ? [] : [image]
  })
  const resultText =
    parts
      .flatMap((part) => {
        if (part.type === "content") {
          const content = acpRecord(part.content)
          return content.type === "text" && typeof content.text === "string"
            ? [content.text]
            : []
        }
        if (part.type === "terminal" && typeof part.terminalId === "string")
          return [`Terminal ${part.terminalId}`]
        return []
      })
      .join("\n") || acpString(wire.rawOutput)
  const changes = parts.flatMap((part): FileChange[] => {
    if (
      part.type !== "diff" ||
      typeof part.path !== "string" ||
      typeof part.newText !== "string"
    )
      return []
    const oldText = typeof part.oldText === "string" ? part.oldText : ""
    const added = part.oldText === null || part.oldText === undefined
    const text = createTwoFilesPatch(
      added ? "/dev/null" : part.path,
      part.path,
      oldText,
      part.newText,
      undefined,
      undefined,
      { maxEditLength: diffEditSafetyLimit },
    )
    return [
      {
        kind: added ? "add" : "update",
        path: part.path,
        ...(text === undefined
          ? {}
          : {
              diff: { format: "unified" as const, text, truncated: false },
            }),
      },
    ]
  })
  let descriptor: ToolExecutionDescriptor = { type: "dynamic_tool_call" }
  if (
    changes.length > 0 ||
    ((wire.kind === "edit" || wire.kind === "delete" || wire.kind === "move") &&
      path !== undefined)
  ) {
    descriptor = {
      type: "file_change",
      request: {
        operation: "edit",
        paths:
          changes.length > 0
            ? changes.map((change) => change.path)
            : path === undefined
              ? []
              : [path],
      },
      changes,
      ...(changes.some((change) => change.diff === undefined)
        ? { exact: false }
        : {}),
    }
  } else if (wire.kind === "read" && path !== undefined) {
    descriptor = {
      type: "file_read",
      path,
      ...(typeof line === "number" && Number.isSafeInteger(line) && line > 0
        ? { offset: line }
        : {}),
    }
  } else if (
    wire.kind === "execute" ||
    acpString(input.command ?? input.cmd) !== undefined
  ) {
    const command = acpString(input.command ?? input.cmd) ?? title
    if (command !== undefined)
      descriptor = {
        type: "command_execution",
        command,
        ...(title === undefined || title === command
          ? {}
          : { description: title }),
      }
  } else if (wire.kind === "search") {
    descriptor = {
      type: "file_search",
      operation: "grep",
      pattern: acpString(input.pattern ?? input.query) ?? title ?? "",
      ...(path === undefined ? {} : { path }),
      lineNumbers: false,
    }
  } else if (wire.kind === "fetch") {
    const url = acpString(input.url)
    if (url !== undefined) descriptor = { type: "web_fetch", url }
  }
  const state =
    wire.status === "failed"
      ? "failed"
      : wire.status === "completed"
        ? "completed"
        : "requested"
  return {
    kind: "tool",
    origin: "engine",
    toolCallId: `acp:${toolCallId}`,
    turnId,
    execution: {
      ...descriptor,
      itemId: `acp:tool:${toolCallId}`,
      toolCallId: `acp:${toolCallId}`,
      name: acpString(wire.name) ?? title ?? "External tool",
      input: isJsonValue(wire.rawInput) ? wire.rawInput : {},
      requiresPermission,
    },
    state,
    ...(locations.size === 0 ? {} : { locations: [...locations.values()] }),
    ...(images.length === 0 ? {} : { resultContent: images }),
    ...(resultText === undefined
      ? {}
      : state === "requested"
        ? { streamOutput: resultText }
        : { resultText }),
    ...(state === "failed" ? { resultError: true } : {}),
  }
}
