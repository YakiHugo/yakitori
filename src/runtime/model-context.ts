import { createHash } from "node:crypto"
import {
  type EventMetadata,
  InputRole,
  ItemKind,
  type ItemProjection,
  ItemStatus,
  type SessionProjection,
  type TurnProjection,
  TurnState,
} from "../kernel/index.ts"
import type { ModelMessage, ModelToolResultMessage } from "./model.ts"

export type ModelContextLimits = {
  readonly modelVisibleMessageBlocks: number
  readonly modelVisibleContextBytes: number
  readonly modelVisibleToolResultBytes: number
  readonly modelVisibleToolResultLines: number
}

export type DroppedTurn = {
  readonly turnId: string
  readonly messages: readonly ModelMessage[]
}

export type ModelContextBuildResult = {
  readonly messages: readonly ModelMessage[]
  readonly selectedItemIds: readonly string[]
  readonly observationEligibleToolResultItemIds: readonly string[]
  readonly droppedTurnCount: number
  readonly droppedTurns: readonly DroppedTurn[]
  readonly droppedCompactionCheckpoint: boolean
  readonly truncatedToolResultCount: number
  readonly prunedToolResultCount: number
}

// Before any Turn group is dropped, old tool results are replaced with a
// placeholder — cheaper than summarizing, and usually enough. Only results in
// the most recent completed Turn groups (plus the current group) stay intact;
// pruned results stop counting as observations so edit tools force a re-read.
const PRUNE_PROTECT_RECENT_TURNS = 2
const PRUNED_TOOL_RESULT_CONTENT =
  "[Old tool result content cleared to free context budget.]"

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

  const coveredTurnIds = new Set(input.session.compaction?.coveredTurnIds ?? [])
  const turnGroups = buildTurnGroups(input.session).filter(
    (group) => !coveredTurnIds.has(group.turnId),
  )
  const compactionGroup = buildCompactionGroup(input.session)
  const forkGroup = buildForkGroup(input.session)
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
  const readResultKeys = buildReadResultKeys(input.session)
  const toolResultItemIds = new Map(
    input.session.tools.flatMap((tool) =>
      tool.resultItemId === undefined
        ? []
        : [[tool.toolCallId, tool.resultItemId] as const],
    ),
  )

  const droppedTurns: DroppedTurn[] = []
  let droppedCompactionCheckpoint = false
  let selectedGroups: readonly ContextGroup[] = [
    ...(compactionGroup === undefined ? [] : [compactionGroup]),
    ...(forkGroup === undefined ? [] : [forkGroup]),
    ...turnGroups,
    currentGroup,
  ]
  let assembled = assembleGroups(selectedGroups, input.limits, readResultKeys)

  // Over budget? First try pruning old tool results; only when that is not
  // enough do whole Turn groups drop. Pruning stays on for every subsequent
  // assembly, including the summarization source for dropped groups.
  const pruneToolResults = exceedsCaps(assembled, input.limits)
  if (pruneToolResults) {
    assembled = assembleGroups(
      selectedGroups,
      input.limits,
      readResultKeys,
      true,
    )
  }

  // The checkpoint is pinned until last resort and the final group — the
  // current input or active Turn — is never dropped: the oldest remaining
  // completed Turn group drops first, and the compaction group drops only
  // when no droppable Turn groups remain. Message order stays
  // checkpoint-first either way.
  while (selectedGroups.length > 1 && exceedsCaps(assembled, input.limits)) {
    const lastIndex = selectedGroups.length - 1
    const turnIndex = selectedGroups.findIndex(
      (group, index) => index < lastIndex && group.kind === "turn",
    )
    const dropIndex = turnIndex === -1 ? 0 : turnIndex
    const dropped = selectedGroups[dropIndex]
    if (dropped === undefined) break
    if (dropped.kind === "turn") {
      // Reuse per-group assembly so summarization input gets the same
      // tool-result truncation as selected groups. A lone dropped group is
      // its own most-recent group, so the default recent-turn protection
      // would shield all of its tool results from pruning; disable it here.
      droppedTurns.push({
        turnId: dropped.turnId,
        messages: assembleGroups(
          [dropped],
          input.limits,
          readResultKeys,
          pruneToolResults,
          0,
        ).messages,
      })
    }
    if (dropped.kind === "compaction") {
      droppedCompactionCheckpoint = true
    }
    selectedGroups = selectedGroups.filter((_, index) => index !== dropIndex)
    assembled = assembleGroups(
      selectedGroups,
      input.limits,
      readResultKeys,
      pruneToolResults,
    )
  }

  if (selectedGroups.length === 1 && exceedsCaps(assembled, input.limits)) {
    throw new Error(
      `Current Turn context exceeds the configured hard cap (${assembled.byteCount} bytes, ${assembled.blockCount} blocks).`,
    )
  }

  return {
    messages: assembled.messages,
    selectedItemIds: assembled.itemIds,
    observationEligibleToolResultItemIds: assembled.visibleToolCallIds.flatMap(
      (toolCallId) => {
        const itemId = toolResultItemIds.get(toolCallId)
        return itemId === undefined ? [] : [itemId]
      },
    ),
    droppedTurnCount: droppedTurns.length,
    droppedTurns,
    droppedCompactionCheckpoint,
    truncatedToolResultCount: assembled.truncatedToolResultCount,
    prunedToolResultCount: assembled.prunedToolResultCount,
  }
}

// Manual compaction source: every completed, still-uncovered Turn group,
// assembled with the same tool-result truncation as a real context build.
export function collectUncoveredTurns(
  session: SessionProjection,
  limits: ModelContextLimits,
): readonly DroppedTurn[] {
  const coveredTurnIds = new Set(session.compaction?.coveredTurnIds ?? [])
  const readResultKeys = buildReadResultKeys(session)
  return buildTurnGroups(session)
    .filter((group) => !coveredTurnIds.has(group.turnId))
    .map((group) => ({
      turnId: group.turnId,
      messages: assembleGroups([group], limits, readResultKeys).messages,
    }))
}

type TurnContextGroup = {
  readonly kind: "turn"
  readonly turnId: string
  readonly messages: readonly ModelMessage[]
  readonly itemIds: readonly string[]
}

type ContextGroup =
  | TurnContextGroup
  | {
      readonly kind: "compaction"
      readonly messages: readonly ModelMessage[]
      readonly itemIds: readonly string[]
    }
  | {
      readonly kind: "fork"
      readonly messages: readonly ModelMessage[]
      readonly itemIds: readonly string[]
    }
  | {
      readonly kind: "current_input"
      readonly inputId: string
      readonly messages: readonly ModelMessage[]
      readonly itemIds: readonly string[]
    }

function buildCompactionGroup(
  session: SessionProjection,
): ContextGroup | undefined {
  const compaction = session.compaction
  if (compaction === undefined) return undefined
  return {
    kind: "compaction",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<context_compacted>\nEarlier turns in this session were summarized into this checkpoint. The complete history is preserved on disk.\n${compaction.summary}\n</context_compacted>`,
          },
        ],
      },
    ],
    itemIds: [],
  }
}

function buildForkGroup(session: SessionProjection): ContextGroup | undefined {
  if (session.forkReason === undefined) return undefined
  const action = session.forkReason === "edit" ? "edited" : "undone"
  return {
    kind: "fork",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<session_forked reason="${session.forkReason}">\nThis session continues a conversation that was ${action} at an earlier point. Actions taken after that point in the previous session were NOT rolled back: files, command effects, processes, and the environment may still reflect them. Do not rely on remembered file contents or tool results from before this notice; inspect current state and re-read files before editing them.\n</session_forked>`,
          },
        ],
      },
    ],
    itemIds: [],
  }
}

function buildTurnGroups(session: SessionProjection): TurnContextGroup[] {
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
): TurnContextGroup | undefined {
  const active = session.activeTurn
  if (!active || active.inputId !== currentInputId) return undefined
  return buildTurnGroup(session, active, true)
}

function buildTurnGroup(
  session: SessionProjection,
  turn: TurnProjection,
  includeOpenTools: boolean,
): TurnContextGroup | undefined {
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
        readonly type: "reasoning"
        readonly text: string
        readonly providerMetadata?: EventMetadata
      }
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
        if (block.type === "text" || block.type === "reasoning") return block
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
      item.kind === ItemKind.Reasoning &&
      item.status === ItemStatus.Completed &&
      item.content.kind === "text"
    ) {
      pendingAssistant.push({
        type: "reasoning",
        text: item.content.text,
        ...(item.providerMetadata === undefined
          ? {}
          : { providerMetadata: item.providerMetadata }),
      })
      itemIds.push(item.itemId)
      continue
    }
    if (
      item.kind === ItemKind.AssistantMessage &&
      item.status === ItemStatus.Completed &&
      item.content.kind === "text" &&
      item.content.text.length > 0
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

function exceedsCaps(
  assembled: {
    readonly byteCount: number
    readonly blockCount: number
  },
  limits: ModelContextLimits,
): boolean {
  return (
    assembled.blockCount > limits.modelVisibleMessageBlocks ||
    assembled.byteCount > limits.modelVisibleContextBytes
  )
}

function assembleGroups(
  groups: readonly ContextGroup[],
  limits: ModelContextLimits,
  readResultKeys: ReadonlyMap<string, string>,
  pruneToolResults = false,
  protectRecentTurnCount = PRUNE_PROTECT_RECENT_TURNS,
): {
  readonly messages: readonly ModelMessage[]
  readonly itemIds: readonly string[]
  readonly visibleToolCallIds: readonly string[]
  readonly truncatedToolResultCount: number
  readonly prunedToolResultCount: number
  readonly byteCount: number
  readonly blockCount: number
} {
  const messages: ModelMessage[] = []
  const itemIds: string[] = []
  const visibleToolCallIds: string[] = []
  const visibleReads = new Map<string, string>()
  let truncatedToolResultCount = 0
  let prunedToolResultCount = 0

  const protectedTurnIds = new Set(
    // slice(-0) would return every element, so guard the zero case.
    protectRecentTurnCount === 0
      ? []
      : groups
          .filter((group) => group.kind === "turn")
          .slice(-protectRecentTurnCount)
          .map((group) => group.turnId),
  )

  for (const group of groups) {
    itemIds.push(...group.itemIds)
    const prunable =
      pruneToolResults &&
      group.kind === "turn" &&
      !protectedTurnIds.has(group.turnId)
    for (const message of group.messages) {
      if (message.role === "tool") {
        // Pruned results carry no content: they neither register as read
        // representatives nor count as file observations, so edit tools
        // force the model to re-read before mutating.
        if (prunable) {
          prunedToolResultCount += 1
          messages.push({ ...message, content: PRUNED_TOOL_RESULT_CONTENT })
          continue
        }
        const readKey = readResultKeys.get(message.toolCallId)
        const representative =
          readKey === undefined ? undefined : visibleReads.get(readKey)
        const projected =
          representative === undefined
            ? message
            : {
                ...message,
                content: `Duplicate read; same content as tool call ${representative}.`,
              }
        if (readKey !== undefined && representative === undefined) {
          visibleReads.set(readKey, message.toolCallId)
        }
        const truncated = truncateToolResult(projected, limits)
        if (truncated.truncated) truncatedToolResultCount += 1
        if (!truncated.truncated && representative === undefined) {
          visibleToolCallIds.push(message.toolCallId)
        }
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
    visibleToolCallIds,
    truncatedToolResultCount,
    prunedToolResultCount,
    byteCount,
    blockCount,
  }
}

function buildReadResultKeys(
  session: SessionProjection,
): ReadonlyMap<string, string> {
  const keys = new Map<string, string>()
  const items = new Map(session.items.map((item) => [item.itemId, item]))
  for (const tool of session.tools) {
    if (tool.name !== "read_file" || !isRecord(tool.output)) continue
    const range = tool.output.range
    if (
      typeof tool.output.path !== "string" ||
      typeof tool.output.sha256 !== "string" ||
      !isRecord(range) ||
      typeof range.offset !== "number" ||
      typeof range.requestedLimit !== "number"
    ) {
      continue
    }
    const resultItem =
      tool.resultItemId === undefined ? undefined : items.get(tool.resultItemId)
    if (resultItem?.content.kind !== "text") continue
    keys.set(
      tool.toolCallId,
      JSON.stringify({
        path: tool.output.path,
        sha256: tool.output.sha256,
        offset: range.offset,
        requestedLimit: range.requestedLimit,
        lineCharacterLimit: tool.output.lineCharacterLimit,
        contentSha256: createHash("sha256")
          .update(resultItem.content.text)
          .digest("hex"),
      }),
    )
  }
  return keys
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
