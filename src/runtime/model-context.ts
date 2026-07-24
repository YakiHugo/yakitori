import {
  InputRole,
  ItemKind,
  ItemStatus,
  TurnState,
  type ItemProjection,
  type SessionProjection,
  type TurnProjection,
} from "../kernel/index.ts"
import type { ModelMessage, ModelToolResultMessage } from "./model.ts"

export type ModelContextLimits = {
  readonly modelVisibleMessageBlocks: number
  readonly modelVisibleContextBytes: number
  readonly modelVisibleToolResultBytes: number
  readonly modelVisibleToolResultLines: number
}

export type ModelContextBuildResult = {
  readonly messages: readonly ModelMessage[]
  readonly selectedItemIds: readonly string[]
  readonly droppedTurnCount: number
  readonly truncatedToolResultCount: number
  readonly byteCount: number
  readonly blockCount: number
}

export function buildModelContext(input: {
  readonly session: SessionProjection
  readonly currentInputId: string
  readonly limits: ModelContextLimits
}): ModelContextBuildResult {
  const currentInput = input.session.inputs.find(
    (candidate) => candidate.inputId === input.currentInputId,
  )
  if (!currentInput) {
    throw new Error(`Current input ${input.currentInputId} was not found.`)
  }

  const turnGroups = buildTurnGroups(input.session)
  const activeGroup = buildActiveTurnGroup(input.session, input.currentInputId)
  const currentGroup: ContextGroup = activeGroup ?? {
    kind: "current_input",
    inputId: currentInput.inputId,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: currentInput.content.text }],
      },
    ],
    itemIds: [],
  }

  let droppedTurnCount = 0
  let selectedGroups = [...turnGroups, currentGroup]
  let assembled = assembleGroups(selectedGroups, input.limits)

  while (
    selectedGroups.length > 1 &&
    (assembled.blockCount > input.limits.modelVisibleMessageBlocks ||
      assembled.byteCount > input.limits.modelVisibleContextBytes)
  ) {
    selectedGroups = selectedGroups.slice(1)
    droppedTurnCount += 1
    assembled = assembleGroups(selectedGroups, input.limits)
  }

  if (
    selectedGroups.length === 1 &&
    (assembled.blockCount > input.limits.modelVisibleMessageBlocks ||
      assembled.byteCount > input.limits.modelVisibleContextBytes)
  ) {
    throw new Error(
      `Current Turn context exceeds the configured hard cap (${assembled.byteCount} bytes, ${assembled.blockCount} blocks).`,
    )
  }

  return {
    messages: assembled.messages,
    selectedItemIds: assembled.itemIds,
    droppedTurnCount,
    truncatedToolResultCount: assembled.truncatedToolResultCount,
    byteCount: assembled.byteCount,
    blockCount: assembled.blockCount,
  }
}

type ContextGroup =
  | {
      readonly kind: "turn"
      readonly turnId: string
      readonly messages: readonly ModelMessage[]
      readonly itemIds: readonly string[]
    }
  | {
      readonly kind: "current_input"
      readonly inputId: string
      readonly messages: readonly ModelMessage[]
      readonly itemIds: readonly string[]
    }

function buildTurnGroups(session: SessionProjection): ContextGroup[] {
  const terminalTurns = session.turns.filter(
    (turn) => turn.state !== TurnState.Started,
  )
  return terminalTurns.flatMap((turn) => {
    const group = buildTurnGroup(session, turn, false)
    return group === undefined ? [] : [group]
  })
}

function buildActiveTurnGroup(
  session: SessionProjection,
  currentInputId: string,
): ContextGroup | undefined {
  const active = session.activeTurn
  if (!active || active.inputId !== currentInputId) return undefined
  return buildTurnGroup(session, active, true)
}

function buildTurnGroup(
  session: SessionProjection,
  turn: TurnProjection,
  includeOpenTools: boolean,
): ContextGroup | undefined {
  const input = session.inputs.find(
    (candidate) => candidate.inputId === turn.inputId,
  )
  if (!input || input.role !== InputRole.User) return undefined

  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: input.content.text }],
    },
  ]
  const itemIds: string[] = []
  const turnItems = turn.itemIds
    .map((itemId) => session.items.find((item) => item.itemId === itemId))
    .filter((item): item is ItemProjection => item !== undefined)

  // Emit assistant/tool exchanges in order so multi-round tool loops remain coherent.
  let pendingAssistant: Array<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "tool_call"
        readonly id: string
        readonly name: string
        readonly input: unknown
      }
  > = []
  const flushAssistant = () => {
    if (pendingAssistant.length === 0) return
    messages.push({
      role: "assistant",
      content: pendingAssistant.map((block) => {
        if (block.type === "text") return block
        return {
          type: "tool_call",
          id: block.id,
          name: block.name,
          input: block.input as never,
        }
      }),
    })
    pendingAssistant = []
  }

  for (const item of turnItems) {
    if (
      item.kind === ItemKind.AssistantMessage &&
      item.status === ItemStatus.Completed &&
      item.content.kind === "text"
    ) {
      pendingAssistant.push({ type: "text", text: item.content.text })
      itemIds.push(item.itemId)
      continue
    }
    if (
      item.kind === ItemKind.ToolCall &&
      item.status === ItemStatus.Completed
    ) {
      const tool = session.tools.find(
        (candidate) => candidate.requestItemId === item.itemId,
      )
      if (!tool) continue
      pendingAssistant.push({
        type: "tool_call",
        id: tool.toolCallId,
        name: tool.name,
        input: tool.input,
      })
      itemIds.push(item.itemId)
      if (!includeOpenTools && tool.resultItemId === undefined) {
        flushAssistant()
        messages.push({
          role: "tool",
          toolCallId: tool.toolCallId,
          content:
            "No tool result was recorded. Execution status and side effects are unknown. Inspect the current state before retrying.",
          isError: true,
        })
      }
      continue
    }
    if (item.kind === ItemKind.ToolResult) {
      flushAssistant()
      const tool = session.tools.find(
        (candidate) => candidate.resultItemId === item.itemId,
      )
      const toolCallId = tool?.toolCallId ?? `missing_tool_${item.itemId}`
      const text =
        item.content.kind === "text"
          ? item.content.text
          : JSON.stringify(item.content.value)
      messages.push({
        role: "tool",
        toolCallId,
        content: text,
        ...(tool?.state === "failed" || item.status === ItemStatus.Failed
          ? { isError: true }
          : {}),
      })
      itemIds.push(item.itemId)
    }
  }

  flushAssistant()
  const notice = terminalTurnNotice(turn)
  if (notice !== undefined) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: notice }],
    })
  }

  return {
    kind: "turn",
    turnId: turn.turnId,
    messages,
    itemIds,
  }
}

function terminalTurnNotice(turn: TurnProjection): string | undefined {
  if (turn.state === TurnState.Completed) return undefined
  if (turn.state === TurnState.Failed) {
    return `<turn_failed>\nThe previous turn failed because a known operation errored: ${turn.error?.message ?? "unknown error"}. Completed messages and tool results above remain valid.\n</turn_failed>`
  }
  if (turn.state === TurnState.Cancelled) {
    return `<turn_cancelled>\nThe previous turn was deliberately stopped${turn.cancelledReason === undefined ? "." : `: ${turn.cancelledReason}`}. Open tools may have partially executed; inspect current state before retrying.\n</turn_cancelled>`
  }
  if (turn.state === TurnState.Interrupted) {
    return `<turn_interrupted>\nThe previous turn lost its runtime before a clean execution boundary was recorded${turn.interruptedReason === undefined ? "." : `: ${turn.interruptedReason}`}. Open tools may have partially executed; inspect current state before retrying.\n</turn_interrupted>`
  }
  return undefined
}

function assembleGroups(
  groups: readonly ContextGroup[],
  limits: ModelContextLimits,
): {
  readonly messages: readonly ModelMessage[]
  readonly itemIds: readonly string[]
  readonly truncatedToolResultCount: number
  readonly byteCount: number
  readonly blockCount: number
} {
  const messages: ModelMessage[] = []
  const itemIds: string[] = []
  let truncatedToolResultCount = 0

  for (const group of groups) {
    itemIds.push(...group.itemIds)
    for (const message of group.messages) {
      if (message.role === "tool") {
        const truncated = truncateToolResult(message, limits)
        if (truncated.truncated) truncatedToolResultCount += 1
        messages.push(truncated.message)
        continue
      }
      messages.push(message)
    }
  }

  const blockCount = countBlocks(messages)
  const byteCount = utf8Bytes(JSON.stringify(messages))
  return {
    messages,
    itemIds,
    truncatedToolResultCount,
    byteCount,
    blockCount,
  }
}

function truncateToolResult(
  message: ModelToolResultMessage,
  limits: ModelContextLimits,
): { readonly message: ModelToolResultMessage; readonly truncated: boolean } {
  const lines = message.content.split("\n")
  let text = message.content
  let truncated = false

  if (lines.length > limits.modelVisibleToolResultLines) {
    text = `${lines.slice(0, limits.modelVisibleToolResultLines).join("\n")}\n...[truncated ${lines.length - limits.modelVisibleToolResultLines} lines]`
    truncated = true
  }

  while (
    utf8Bytes(text) > limits.modelVisibleToolResultBytes &&
    text.length > 0
  ) {
    text = `${text.slice(0, Math.max(0, text.length - 1_024))}\n...[truncated bytes]`
    truncated = true
  }

  return {
    message: {
      ...message,
      content: text,
    },
    truncated,
  }
}

function countBlocks(messages: readonly ModelMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.role === "tool") return count + 1
    return count + message.content.length
  }, 0)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
