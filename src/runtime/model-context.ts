import { createHash } from "node:crypto"
import {
  type EventMetadata,
  InputRole,
  ItemKind,
  type ItemProjection,
  ItemStatus,
  type JsonObject,
  type SessionProjection,
  type TextContent,
  type TurnProjection,
  TurnState,
  type WorldStateFragment,
} from "../kernel/index.ts"
import type {
  ModelMessage,
  ModelToolResultMessage,
  ModelUserMessage,
} from "./model.ts"
import { WorldStateSectionId } from "./world-state.ts"

export type ModelContextLimits = {
  readonly modelVisibleMessageBlocks: number
  readonly modelVisibleContextBytes: number
  readonly compactionTriggerContextBytes?: number
  readonly compactionRetainContextBytes?: number
  readonly modelVisibleToolResultBytes: number
  readonly modelVisibleToolResultLines: number
}

export type DroppedTurn = {
  readonly turnId: string
  readonly messages: readonly ModelMessage[]
}

export type CompactionSourceGroup = {
  readonly kind: "inherited" | "compaction" | "turn"
  readonly turnIds: readonly string[]
  readonly messages: readonly ModelMessage[]
}

export type ForkedModelContext = Readonly<{
  sourceSessionId: string
  messages: readonly ModelMessage[]
  worldState?: JsonObject
  providerUsageBaseline?: NonNullable<
    SessionProjection["providerUsageBaseline"]
  >
}>

export type ModelContextBuildResult = {
  readonly messages: readonly ModelMessage[]
  readonly selectedItemIds: readonly string[]
  readonly observationEligibleToolResultItemIds: readonly string[]
  readonly droppedTurnCount: number
  readonly droppedTurns: readonly DroppedTurn[]
  readonly compactableHistory: readonly CompactionSourceGroup[]
  readonly forkTurnStartIndexes: readonly number[]
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
  readonly forkedContext?: ForkedModelContext
}): ModelContextBuildResult {
  const currentInput = input.session.inputs.find(
    (candidate) => candidate.inputId === input.currentInputId,
  )
  if (!currentInput) {
    throw new Error(`Current input ${input.currentInputId} was not found.`)
  }

  const coveredTurnIds = new Set(input.session.compaction?.coveredTurnIds ?? [])
  const turnGroups = buildTurnGroups(input.session, coveredTurnIds)
  const compactionGroup = buildCompactionGroup(input.session)
  const inheritedGroup = buildInheritedGroup(
    input.session.compaction?.replacement.replacesInheritedContext
      ? undefined
      : input.session.inheritedContext === undefined
        ? input.forkedContext
        : {
            sourceSessionId: input.session.inheritedContext.sourceSessionId,
            messages: input.session.inheritedContext.history,
            ...(input.session.inheritedContext.worldStateBaseline === undefined
              ? {}
              : {
                  worldState: input.session.inheritedContext.worldStateBaseline,
                }),
          },
  )
  const forkGroup = buildForkGroup(input.session)
  const activeGroup = buildActiveTurnGroup(input.session, input.currentInputId)
  const currentGroup: ContextGroup = activeGroup ?? {
    kind: "current_input",
    inputId: currentInput.inputId,
    messages: [modelUserMessage(currentInput.content)],
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
    ...(inheritedGroup === undefined ? [] : [inheritedGroup]),
    ...(compactionGroup === undefined ? [] : [compactionGroup]),
    ...turnGroups,
    // Keep inherited conversation history as the stable prompt prefix. The
    // fork notice describes local state, so placing it after inherited Turns
    // avoids invalidating the provider cache for the entire shared history.
    ...(forkGroup === undefined ? [] : [forkGroup]),
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

  // The active Turn is model-visible but not yet terminal, so it belongs to
  // the retained tail even though it uses the same group shape as old Turns.
  const historyGroups = [
    ...(inheritedGroup === undefined ? [] : [inheritedGroup]),
    ...(compactionGroup === undefined ? [] : [compactionGroup]),
    ...turnGroups,
  ].filter(isCompactionHistoryGroup)
  let compactableHistory = selectCompactableHistory({
    historyGroups,
    tailGroups: [...(forkGroup === undefined ? [] : [forkGroup]), currentGroup],
    assembledBytes: assembled.byteCount,
    limits: input.limits,
    readResultKeys,
    pruneToolResults,
  })

  let droppedHistoryPrefixLength = 0
  while (selectedGroups.length > 1 && exceedsCaps(assembled, input.limits)) {
    const lastIndex = selectedGroups.length - 1
    const dropIndex = selectedGroups.findIndex(
      (group, index) => index < lastIndex && group.kind === "turn",
    )
    const fallbackDropIndex = selectedGroups.findIndex(
      (group, index) => index < lastIndex && isCompactionHistoryGroup(group),
    )
    const selectedDropIndex = dropIndex < 0 ? fallbackDropIndex : dropIndex
    if (selectedDropIndex === -1) break
    const dropped = selectedGroups[selectedDropIndex]
    if (dropped === undefined) break
    if (dropped.kind === "turn") {
      // Reuse per-group assembly so summarization input gets the same
      // tool-result truncation as selected groups. A lone dropped group is
      // its own most-recent group, so the default recent-turn protection
      // would shield all of its tool results from pruning; disable it here.
      droppedTurns.push(
        toDroppedTurn(dropped, input.limits, readResultKeys, pruneToolResults),
      )
    }
    if (isCompactionHistoryGroup(dropped)) {
      droppedHistoryPrefixLength = Math.max(
        droppedHistoryPrefixLength,
        historyGroups.indexOf(dropped) + 1,
      )
    }
    if (dropped.kind === "compaction") {
      droppedCompactionCheckpoint = true
    }
    selectedGroups = selectedGroups.filter(
      (_, index) => index !== selectedDropIndex,
    )
    assembled = assembleGroups(
      selectedGroups,
      input.limits,
      readResultKeys,
      pruneToolResults,
    )
  }

  if (exceedsCaps(assembled, input.limits)) {
    throw new Error(
      `Model context exceeds the configured hard cap (${assembled.byteCount} bytes, ${assembled.blockCount} blocks).`,
    )
  }

  // Block pressure can force more of the oldest prefix out than the proactive
  // byte threshold selected. Both lists are head-anchored, so the longer one
  // is the complete safe source for the runner's next compaction attempt.
  if (droppedHistoryPrefixLength > compactableHistory.length) {
    compactableHistory = historyGroups
      .slice(0, droppedHistoryPrefixLength)
      .map((group) =>
        toCompactionSourceGroup(
          group,
          input.limits,
          readResultKeys,
          pruneToolResults,
        ),
      )
  }
  compactableHistory = includeCurrentCheckpoint({
    candidate: compactableHistory,
    historyGroups,
    limits: input.limits,
    readResultKeys,
    pruneToolResults,
  })

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
    compactableHistory,
    forkTurnStartIndexes: assembled.forkTurnStartIndexes,
    droppedCompactionCheckpoint,
    truncatedToolResultCount: assembled.truncatedToolResultCount,
    prunedToolResultCount: assembled.prunedToolResultCount,
  }
}

export function createForkedModelContext(input: {
  readonly sourceSessionId: string
  readonly messages: readonly ModelMessage[]
  readonly worldState?: JsonObject
  readonly preserveWorldState?: boolean
  readonly providerUsageBaseline?: NonNullable<
    SessionProjection["providerUsageBaseline"]
  >
}): ForkedModelContext | undefined {
  const preserveWorldState = input.preserveWorldState ?? true
  const messages = sanitizeForkMessages(input.messages, preserveWorldState)
  const worldState =
    input.worldState === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input.worldState).filter(
            ([sectionId]) => sectionId !== WorldStateSectionId.MultiAgent,
          ),
        )
  return messages.length === 0 &&
    worldState === undefined &&
    input.providerUsageBaseline === undefined
    ? undefined
    : {
        sourceSessionId: input.sourceSessionId,
        messages,
        ...(worldState === undefined ? {} : { worldState }),
        ...(input.providerUsageBaseline === undefined
          ? {}
          : { providerUsageBaseline: input.providerUsageBaseline }),
      }
}

function sanitizeForkMessages(
  messages: readonly ModelMessage[],
  preserveWorldState: boolean,
): readonly ModelMessage[] {
  const sanitized: ModelMessage[] = []
  let pendingAssistant: ModelMessage | undefined
  const flushAssistant = () => {
    if (pendingAssistant === undefined) return
    sanitized.push(pendingAssistant)
    pendingAssistant = undefined
  }

  for (const message of messages) {
    if (message.role === "tool") continue
    if (message.role === "assistant") {
      const content = message.content.filter((block) => block.type === "text")
      if (content.length > 0) {
        pendingAssistant = { role: "assistant", content }
      }
      continue
    }
    const worldState = message.context?.type === "world_state"
    if (
      worldState &&
      (!preserveWorldState ||
        message.context?.sectionId === WorldStateSectionId.MultiAgent)
    ) {
      continue
    }
    flushAssistant()
    sanitized.push(message)
  }
  flushAssistant()
  return sanitized
}

function selectCompactableHistory(input: {
  readonly historyGroups: readonly CompactionHistoryGroup[]
  readonly tailGroups: readonly ContextGroup[]
  readonly assembledBytes: number
  readonly limits: ModelContextLimits
  readonly readResultKeys: ReadonlyMap<string, string>
  readonly pruneToolResults: boolean
}): readonly CompactionSourceGroup[] {
  const triggerBytes = input.limits.compactionTriggerContextBytes
  const retainBytes = input.limits.compactionRetainContextBytes
  if (
    triggerBytes === undefined ||
    retainBytes === undefined ||
    input.assembledBytes < triggerBytes ||
    input.historyGroups.length === 0
  ) {
    return []
  }

  let retainedBytes = assembleGroups(
    input.tailGroups,
    input.limits,
    input.readResultKeys,
    input.pruneToolResults,
  ).byteCount
  let keepFromIndex = input.historyGroups.length
  for (let index = input.historyGroups.length - 1; index >= 0; index -= 1) {
    if (retainedBytes >= retainBytes) break
    const group = input.historyGroups[index]
    if (group === undefined) break
    retainedBytes += assembleGroups(
      [group],
      input.limits,
      input.readResultKeys,
      input.pruneToolResults,
    ).byteCount
    keepFromIndex = index
  }

  const checkpointIndex = input.historyGroups.findIndex(
    (group) => group.kind === "compaction",
  )
  const sourceLength =
    keepFromIndex === 0 || checkpointIndex < 0
      ? keepFromIndex
      : Math.max(keepFromIndex, checkpointIndex + 1)

  const source = input.historyGroups
    .slice(0, sourceLength)
    .map((group) =>
      toCompactionSourceGroup(
        group,
        input.limits,
        input.readResultKeys,
        input.pruneToolResults,
      ),
    )
  return source.some((group) => group.kind !== "compaction") ? source : []
}

function includeCurrentCheckpoint(input: {
  readonly candidate: readonly CompactionSourceGroup[]
  readonly historyGroups: readonly CompactionHistoryGroup[]
  readonly limits: ModelContextLimits
  readonly readResultKeys: ReadonlyMap<string, string>
  readonly pruneToolResults: boolean
}): readonly CompactionSourceGroup[] {
  if (input.candidate.length === 0) return input.candidate
  const checkpointIndex = input.historyGroups.findIndex(
    (group) => group.kind === "compaction",
  )
  if (checkpointIndex < 0 || input.candidate.length > checkpointIndex) {
    return input.candidate
  }
  return input.historyGroups
    .slice(0, checkpointIndex + 1)
    .map((group) =>
      toCompactionSourceGroup(
        group,
        input.limits,
        input.readResultKeys,
        input.pruneToolResults,
      ),
    )
}

function toCompactionSourceGroup(
  group: CompactionHistoryGroup,
  limits: ModelContextLimits,
  readResultKeys: ReadonlyMap<string, string>,
  pruneToolResults: boolean,
): CompactionSourceGroup {
  return {
    kind: group.kind,
    turnIds: group.kind === "turn" ? [group.turnId] : [],
    messages: prepareCompactionMessages(
      assembleGroups([group], limits, readResultKeys, pruneToolResults, 0)
        .messages,
    ),
  }
}

function toDroppedTurn(
  group: TurnContextGroup,
  limits: ModelContextLimits,
  readResultKeys: ReadonlyMap<string, string>,
  pruneToolResults: boolean,
): DroppedTurn {
  return {
    turnId: group.turnId,
    // A lone group is its own most-recent group, so disable the usual recent
    // protection when pressure pruning must also shape the summary source.
    messages: prepareCompactionMessages(
      assembleGroups([group], limits, readResultKeys, pruneToolResults, 0)
        .messages,
    ),
  }
}

function prepareCompactionMessages(
  messages: readonly ModelMessage[],
): readonly ModelMessage[] {
  return messages.filter((message) => {
    if (
      (message.role === "user" || message.role === "developer") &&
      message.context?.type === "world_state"
    ) {
      return false
    }
    return true
  })
}

// Manual compaction source: every completed, still-uncovered Turn group,
// assembled with the same tool-result truncation as a real context build.
export function collectUncoveredTurns(
  session: SessionProjection,
  limits: ModelContextLimits,
): readonly CompactionSourceGroup[] {
  const coveredTurnIds = new Set(session.compaction?.coveredTurnIds ?? [])
  const readResultKeys = buildReadResultKeys(session)
  const inherited = buildInheritedGroup(
    session.inheritedContext === undefined ||
      session.compaction?.replacement.replacesInheritedContext
      ? undefined
      : {
          sourceSessionId: session.inheritedContext.sourceSessionId,
          messages: session.inheritedContext.history,
        },
  )
  const compaction = buildCompactionGroup(session)
  const source = [
    ...(inherited === undefined ? [] : [inherited]),
    ...(compaction === undefined ? [] : [compaction]),
    ...buildTurnGroups(session, coveredTurnIds),
  ]
    .filter(isCompactionHistoryGroup)
    .map((group) =>
      toCompactionSourceGroup(group, limits, readResultKeys, false),
    )
  return source.some((group) => group.kind !== "compaction") ? source : []
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
      readonly kind: "inherited"
      readonly messages: readonly ModelMessage[]
      readonly itemIds: readonly string[]
    }
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

type CompactionHistoryGroup = Extract<
  ContextGroup,
  { readonly kind: "inherited" | "compaction" | "turn" }
>

function isCompactionHistoryGroup(
  group: ContextGroup,
): group is CompactionHistoryGroup {
  return (
    group.kind === "inherited" ||
    group.kind === "compaction" ||
    group.kind === "turn"
  )
}

function buildInheritedGroup(
  context: ForkedModelContext | undefined,
): ContextGroup | undefined {
  if (context === undefined || context.messages.length === 0) return undefined
  return {
    kind: "inherited",
    messages: context.messages,
    itemIds: [],
  }
}

function buildCompactionGroup(
  session: SessionProjection,
): ContextGroup | undefined {
  const compaction = session.compaction
  if (compaction === undefined) return undefined
  return {
    kind: "compaction",
    messages: compaction.replacement.history,
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
            text: `<session_forked reason="${session.forkReason}">\nThis session continues a conversation that was ${action} at an earlier point. Actions taken after that point in the previous session were NOT rolled back: files, command effects, processes, and the environment may still reflect them.\n</session_forked>`,
          },
        ],
      },
    ],
    itemIds: [],
  }
}

function buildTurnGroups(
  session: SessionProjection,
  excludedTurnIds: ReadonlySet<string> = new Set(),
): TurnContextGroup[] {
  const terminalTurns = session.turns.filter(
    (turn) =>
      turn.state !== TurnState.Started && !excludedTurnIds.has(turn.turnId),
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

  const worldStateUpdates = session.worldStateUpdates.filter(
    (update) =>
      update.turnId === turn.turnId &&
      (session.compaction === undefined ||
        update.seq > session.compaction.throughSeq),
  )
  const messages: ModelMessage[] = [
    ...worldStateMessages(
      worldStateUpdates.filter((update) => update.afterItemId === undefined),
    ),
    modelUserMessage(input.content),
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
  const appendWorldStateAfter = (itemId: string) => {
    const updates = worldStateUpdates.filter(
      (update) => update.afterItemId === itemId,
    )
    if (updates.length === 0) return
    flushAssistant()
    messages.push(...worldStateMessages(updates))
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
      appendWorldStateAfter(item.itemId)
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
      appendWorldStateAfter(item.itemId)
      continue
    }
    if (
      item.kind === ItemKind.ToolCall &&
      item.status === ItemStatus.Completed
    ) {
      const tool = session.tools.find(
        (candidate) => candidate.requestItemId === item.itemId,
      )
      if (!tool) {
        appendWorldStateAfter(item.itemId)
        continue
      }
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
      appendWorldStateAfter(item.itemId)
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
      appendWorldStateAfter(item.itemId)
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

function worldStateMessages(
  updates: SessionProjection["worldStateUpdates"],
): ModelMessage[] {
  return updates.flatMap((update) =>
    update.fragments.map((fragment) => ({
      role: fragment.role,
      content: [{ type: "text" as const, text: fragment.text }],
      context: {
        type: "world_state" as const,
        sectionId: fragment.id,
        revision: fragment.revision,
      },
    })),
  )
}

export function createCompactionReplacementHistory(input: {
  readonly summary: string
  readonly worldStateFragments?: readonly WorldStateFragment[]
}): readonly ModelMessage[] {
  return [
    ...(input.worldStateFragments ?? []).map((fragment) => ({
      role: fragment.role,
      content: [{ type: "text" as const, text: fragment.text }],
      context: {
        type: "world_state" as const,
        sectionId: fragment.id,
        revision: fragment.revision,
      },
    })),
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<context_compacted>\nEarlier turns in this session were summarized into this checkpoint. The complete history is preserved on disk.\n${input.summary}\n</context_compacted>`,
        },
      ],
    },
  ]
}

function modelUserMessage(content: TextContent): ModelUserMessage {
  const images = (content.attachments ?? []).map((attachment) => ({
    type: "image" as const,
    mediaType: attachment.mediaType,
    detail: attachment.detail ?? "high",
    file: attachment.file,
    sizeBytes: attachment.sizeBytes,
  }))
  return {
    role: "user",
    content:
      content.text.length === 0
        ? []
        : [{ type: "text" as const, text: content.text }],
    ...(images.length === 0 ? {} : { images }),
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
  readonly forkTurnStartIndexes: readonly number[]
  readonly byteCount: number
  readonly blockCount: number
} {
  const messages: ModelMessage[] = []
  const itemIds: string[] = []
  const visibleToolCallIds: string[] = []
  const forkTurnStartIndexes: number[] = []
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
    if (group.kind === "turn" || group.kind === "current_input") {
      forkTurnStartIndexes.push(messages.length)
    }
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
  const byteCount = measureModelMessagesBytes(messages)
  return {
    messages,
    itemIds,
    visibleToolCallIds,
    truncatedToolResultCount,
    prunedToolResultCount,
    forkTurnStartIndexes,
    byteCount,
    blockCount,
  }
}

// Raw base64 bytes are transport size, not language-context bytes. Count a
// bounded descriptor here; providers account for vision tokens separately.
export function measureModelMessagesBytes(
  messages: readonly ModelMessage[],
): number {
  return utf8Bytes(
    JSON.stringify(messages, (_key, value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "image" &&
        (("data" in value && typeof value.data === "string") ||
          ("file" in value && "sizeBytes" in value))
      ) {
        const image = value as Record<string, unknown>
        return {
          ...image,
          ...(typeof image.data === "string"
            ? {
                data: `[base64 image: ${Math.floor((image.data.length * 3) / 4)} bytes]`,
              }
            : { file: `[session image: ${String(image.sizeBytes)} bytes]` }),
        }
      }
      return value
    }),
  )
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
    return (
      count +
      message.content.length +
      (message.role === "user" ? (message.images?.length ?? 0) : 0)
    )
  }, 0)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
