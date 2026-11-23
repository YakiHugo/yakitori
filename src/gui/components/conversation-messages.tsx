import { ChevronRight, Info } from "lucide-react"
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { answerTextParts } from "../../protocol/model-output.ts"
import { parseUserQuestions } from "../../protocol/user-interaction.ts"
import { groupConversationActivity } from "../conversation-activity.ts"
import {
  type ActiveModelRetry,
  type ExecutionEntry,
  executionEntryKey,
  type TurnActivityPage,
  type TurnTiming,
} from "../execution-view.ts"
import { cn } from "../lib/utils.ts"
import { useAppStore } from "../store/app-store.ts"
import { useThreadScopeState } from "../store/thread-scope-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { ActivityBatch } from "./activity-batch.tsx"
import { AgentMessageCell } from "./cells/agent-message-cell.tsx"
import { AssistantMessageCell } from "./cells/assistant-message-cell.tsx"
import { HostedToolCell } from "./cells/hosted-tool-cell.tsx"
import { PermissionCell } from "./cells/permission-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { CompactionCell, PlanCell } from "./cells/session-progress-cell.tsx"
import { ToolCell } from "./cells/tool-cell.tsx"
import { TurnTerminalCell } from "./cells/turn-terminal-cell.tsx"
import { UserMessageCell } from "./cells/user-message-cell.tsx"
import {
  type ContextSourceNavigation,
  findContextSource,
  revealContextSourceEvent,
} from "./excerpt-source.tsx"
import {
  encryptedReasoningLabel,
  reasoningSections,
} from "./reasoning-trace.tsx"
import { ResponseActions } from "./response-actions.tsx"
import { TranscriptDisclosureContent } from "./transcript-disclosure.tsx"
import { TurnActivityLabel } from "./turn-activity-label.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import "./activity-timeline.css"

import type { ExecutionView } from "../execution-view.ts"
import { useConversationScope } from "./conversation-scope.tsx"

// Keep admission order, including queued/steering inputs between turn items.
// Only adjacent items of the same turn share a disclosure.
type TranscriptBlock = {
  key: string
  turnId: string | undefined
  entries: readonly ExecutionEntry[]
}

function groupEntries(
  entries: readonly ExecutionEntry[],
  previous: readonly TranscriptBlock[],
  deferred: ExecutionView["deferredTurnActivity"],
): TranscriptBlock[] {
  const blocks: {
    key: string
    turnId: string | undefined
    entries: ExecutionEntry[]
  }[] = []
  const usedKeys = new Map<string, number>()
  let anchor = ""
  for (const entry of entries) {
    const turnId = "turnId" in entry ? entry.turnId : undefined
    if (turnId === undefined) anchor = executionEntryKey(entry)
    const last = blocks.at(-1)
    if (turnId !== undefined && last?.turnId === turnId)
      last.entries.push(entry)
    else {
      // Deferred activity may insert entries before the first reply.
      const base =
        turnId !== undefined && deferred?.[turnId] !== undefined
          ? JSON.stringify([turnId, anchor])
          : executionEntryKey(entry)
      const occurrence = usedKeys.get(base) ?? 0
      usedKeys.set(base, occurrence + 1)
      blocks.push({
        key: occurrence === 0 ? base : JSON.stringify([base, occurrence]),
        turnId,
        entries: [entry],
      })
    }
  }
  const previousByKey = new Map(previous.map((block) => [block.key, block]))
  return blocks.map((block) => {
    const stable = previousByKey.get(block.key)
    return stable !== undefined &&
      stable.turnId === block.turnId &&
      stable.entries.length === block.entries.length &&
      block.entries.every((entry, index) => entry === stable.entries[index])
      ? stable
      : block
  })
}

export function ConversationMessages({
  view,
  historyRevision = 0,
  onInputRef,
}: Readonly<{
  view: ExecutionView
  historyRevision?: number
  onInputRef?: (inputId: string, node: HTMLDivElement | null) => void
}>) {
  const { sessionId } = useConversationScope()
  const previousBlocks = useRef<readonly TranscriptBlock[]>([])
  const previousScope = useRef({ sessionId, historyRevision })
  const previousAnswers = useRef(new Map<string, FinalAnswer>())
  const blocks = useMemo(() => {
    if (
      previousScope.current.sessionId !== sessionId ||
      previousScope.current.historyRevision !== historyRevision
    ) {
      previousBlocks.current = []
      previousAnswers.current.clear()
      previousScope.current = { sessionId, historyRevision }
    }
    const next = groupEntries(
      view.entries,
      previousBlocks.current,
      view.deferredTurnActivity,
    )
    previousBlocks.current = next
    const blocks = [...next]
    const responded = new Set(blocks.map(({ turnId }) => turnId))
    for (const [turnId, page] of Object.entries(
      view.deferredTurnActivity ?? {},
    )) {
      if (page === "loaded" || responded.has(turnId)) continue
      const inputId = view.turnTimings[turnId]?.inputId
      const index = blocks.findIndex(
        ({ entries: [entry] }) =>
          (entry?.kind === "user_input" || entry?.kind === "agent_input") &&
          entry.inputId === inputId,
      )
      blocks.splice(index < 0 ? blocks.length : index + 1, 0, {
        key: JSON.stringify([turnId, blocks[index]?.key ?? ""]),
        turnId,
        entries: [],
      })
    }
    return blocks
  }, [
    sessionId,
    historyRevision,
    view.entries,
    view.deferredTurnActivity,
    view.turnTimings,
  ])
  // Steering inputs can split a turn into several blocks. Its current retry
  // belongs only to the latest block, even when earlier activity is expanded.
  const activeBlockIndex =
    view.activeTurnId === undefined
      ? -1
      : blocks.reduce(
          (last, block, index) =>
            block.turnId === view.activeTurnId ? index : last,
          -1,
        )
  const canPreviewUnmarkedAnswer =
    activeBlockIndex !== -1 &&
    blocks.every(
      (block) =>
        block.turnId !== view.activeTurnId ||
        block.entries.every(
          (entry) =>
            entry.kind === "assistant" &&
            !entry.refusal &&
            entry.purpose !== "commentary",
        ),
    )
  const finalAnswers = useMemo(() => {
    const turns = new Map<
      string,
      { last: ExecutionEntry | undefined; failed: boolean }
    >()
    const assistants = new Map<
      string,
      Extract<ExecutionEntry, { kind: "assistant" }>[]
    >()
    for (const entry of view.entries) {
      if (!("turnId" in entry)) continue
      const turn = turns.get(entry.turnId) ?? { last: undefined, failed: false }
      if (entry.kind === "turn_terminal") {
        turn.failed = ["failed", "cancelled", "interrupted"].includes(
          entry.state,
        )
      } else if (entry.kind !== "permission" && entry.kind !== "compaction")
        turn.last = entry
      if (entry.kind === "assistant") {
        const id = entry.source?.itemId ?? entry.itemId
        assistants.set(id, [...(assistants.get(id) ?? []), entry])
      }
      turns.set(entry.turnId, turn)
    }
    const answers = new Map<string, FinalAnswer>()
    for (const [turnId, turn] of turns) {
      const timing = view.turnTimings[turnId]
      if (
        timing?.completedAt === undefined ||
        view.activeTurnId === turnId ||
        turn.failed
      )
        continue
      const itemIds =
        timing.outcome?.status === "completed" &&
        timing.outcome.answerItemIds !== undefined
          ? timing.outcome.answerItemIds
          : turn.last?.kind === "assistant"
            ? [turn.last.source?.itemId ?? turn.last.itemId]
            : []
      if (itemIds.some((id) => !assistants.has(id))) continue
      const pieces = itemIds
        .flatMap((id) => answerTextParts(assistants.get(id) ?? []))
        .filter((entry) => entry.turnId === turnId && !entry.refusal)
      if (pieces.length === 0) continue
      const previous = previousAnswers.current.get(turnId)
      const answer =
        previous?.pieces.length === pieces.length &&
        previous.pieces.every((entry, index) => entry === pieces[index])
          ? previous
          : composeFinalAnswer(pieces)
      if (answer !== undefined) answers.set(turnId, answer)
    }
    previousAnswers.current = answers
    return answers
  }, [view.entries, view.turnTimings, view.activeTurnId])
  const queued = new Set(view.queuedInputIds)
  return (
    <>
      {blocks.map((block, index) => {
        const first = block.entries[0]
        if (first?.kind === "user_input" || first?.kind === "agent_input")
          return (
            <div
              key={block.key}
              ref={(node) => onInputRef?.(first.inputId, node)}
            >
              {first.kind === "agent_input" ? (
                <AgentMessageCell entry={first} sessionId={sessionId} />
              ) : (
                <UserMessageCell
                  entry={first}
                  queued={queued.has(first.inputId)}
                />
              )}
            </div>
          )
        return block.turnId ? (
          <TurnBlock
            key={`${historyRevision}:${block.key}`}
            blockKey={block.key}
            turnId={block.turnId}
            activityPage={view.deferredTurnActivity?.[block.turnId]}
            entries={block.entries}
            active={view.activeTurnId === block.turnId}
            timing={view.turnTimings[block.turnId]}
            finalAnswer={finalAnswers.get(block.turnId)}
            presentLiveAnswer={index === activeBlockIndex}
            canPreviewUnmarkedAnswer={
              index === activeBlockIndex && canPreviewUnmarkedAnswer
            }
            retry={index === activeBlockIndex ? view.activeRetry : undefined}
          />
        ) : (
          block.entries.map((entry) => (
            <EntryCell key={executionEntryKey(entry)} entry={entry} />
          ))
        )
      })}
      {view.activeTurnId !== undefined && activeBlockIndex === -1 ? (
        <TurnBlock
          key={`${historyRevision}:${view.activeTurnId}`}
          blockKey={view.activeTurnId}
          turnId={view.activeTurnId}
          activityPage={undefined}
          entries={[]}
          active
          timing={view.turnTimings[view.activeTurnId]}
          finalAnswer={undefined}
          presentLiveAnswer={false}
          canPreviewUnmarkedAnswer={false}
          retry={view.activeRetry}
        />
      ) : null}
    </>
  )
}

type FinalAnswer = Readonly<{
  pieces: readonly Extract<ExecutionEntry, { kind: "assistant" }>[]
  itemIds: readonly string[]
  entry: Extract<ExecutionEntry, { kind: "assistant" }>
}>

function composeFinalAnswer(
  pieces: FinalAnswer["pieces"],
): FinalAnswer | undefined {
  const last = pieces.at(-1)
  if (last === undefined) return undefined
  if (pieces.length === 1)
    return { pieces, itemIds: [last.itemId], entry: last }
  let text = ""
  const incomplete = pieces.some((entry) => entry.incomplete)
  const sources = pieces.flatMap((piece) => {
    const offset = text.length
    text += piece.text
    return (piece.sources ?? []).map((source) => ({
      ...source,
      // Citation IDs are local to each recorded assistant item.
      id: JSON.stringify([piece.itemId, source.id]),
      ...(source.mentions === undefined || offset === 0
        ? {}
        : {
            mentions: source.mentions.map(({ responseSpan, ...mention }) => ({
              ...mention,
              responseSpan: {
                start: responseSpan.start + offset,
                end: responseSpan.end + offset,
              },
            })),
          }),
    }))
  })
  return {
    pieces,
    itemIds: pieces.map((piece) => piece.itemId),
    entry: { ...last, text, incomplete, sources },
  }
}

const TurnBlock = memo(
  function TurnBlock({
    blockKey,
    turnId,
    activityPage,
    entries,
    active,
    timing,
    finalAnswer,
    presentLiveAnswer,
    canPreviewUnmarkedAnswer,
    retry,
  }: Readonly<{
    blockKey: string
    turnId: string
    activityPage: TurnActivityPage | undefined
    entries: readonly ExecutionEntry[]
    active: boolean
    timing: TurnTiming | undefined
    finalAnswer: FinalAnswer | undefined
    presentLiveAnswer: boolean
    canPreviewUnmarkedAnswer: boolean
    retry: ActiveModelRetry | undefined
  }>) {
    const { threadId, sessionId, loadTurnActivity } = useConversationScope()
    const [liveActivityCollapsed, setLiveActivityCollapsed] =
      useThreadScopeState(threadId, `turn:${blockKey}:live-collapsed`, false)
    const [activityExpanded, setActivityExpanded] = useThreadScopeState(
      threadId,
      `turn:${blockKey}:activity-expanded`,
      false,
    )
    const [sourceNavigation, setSourceNavigation] =
      useState<ContextSourceNavigation>()
    useEffect(() => {
      const revealSource = (event: Event) => {
        const navigation = (event as CustomEvent<ContextSourceNavigation>)
          .detail
        const { source } = navigation
        if (
          source.kind !== "message" ||
          source.sessionId !== sessionId ||
          !entries.some(
            (entry) =>
              entry.kind === "assistant" && entry.itemId === source.messageId,
          )
        )
          return
        setActivityExpanded(true)
        setLiveActivityCollapsed(false)
        setSourceNavigation(navigation)
      }
      window.addEventListener(revealContextSourceEvent, revealSource)
      return () =>
        window.removeEventListener(revealContextSourceEvent, revealSource)
    }, [entries, sessionId, setActivityExpanded, setLiveActivityCollapsed])
    useLayoutEffect(() => {
      // Navigation can only scroll after the collapsed source has mounted.
      if (sourceNavigation)
        findContextSource(sourceNavigation.source)?.scrollIntoView(
          sourceNavigation.options,
        )
    }, [sourceNavigation])
    const contentId = useId()
    const labelId = useId()
    const completed = !active && timing?.completedAt !== undefined
    const livePieces = useMemo(() => {
      if (!presentLiveAnswer) return []
      const assistants = entries.filter(
        (entry): entry is FinalAnswer["pieces"][number] =>
          entry.kind === "assistant" &&
          !entry.refusal &&
          entry.purpose !== "commentary",
      )
      const explicit = assistants.filter(
        (entry) => entry.purpose === "final_answer",
      )
      return explicit.length > 0 || !canPreviewUnmarkedAnswer
        ? explicit
        : assistants
    }, [entries, presentLiveAnswer, canPreviewUnmarkedAnswer])
    const firstLivePiece = livePieces[0]
    const unmarked =
      firstLivePiece !== undefined && firstLivePiece.purpose === undefined
        ? JSON.stringify([sessionId, firstLivePiece.itemId])
        : undefined
    const [settledUnmarked, setSettledUnmarked] = useState<string>()
    useEffect(() => {
      setSettledUnmarked(undefined)
      if (unmarked === undefined) return
      // Let adjacent tool and reasoning updates claim the process layout
      // before moving an unmarked reply. Text continues updating in place.
      const timer = setTimeout(() => setSettledUnmarked(unmarked), 120)
      return () => clearTimeout(timer)
    }, [unmarked])
    const answer = useMemo(
      () =>
        finalAnswer ??
        (unmarked === undefined || settledUnmarked === unmarked
          ? composeFinalAnswer(livePieces)
          : undefined),
      [finalAnswer, unmarked, settledUnmarked, livePieces],
    )
    const { visibleAnswer, persistent, reasoning, timeline } = useMemo(() => {
      const answerInBlock = entries.some(
        (entry) =>
          entry.kind === "assistant" && entry.itemId === answer?.entry.itemId,
      )
      const visibleAnswer = answerInBlock ? answer?.entry : undefined
      const answerItemIds = new Set(answer?.itemIds)
      const persistent = entries.flatMap<ExecutionEntry>((entry) => {
        if (entry.kind === "assistant" && answerItemIds.has(entry.itemId)) {
          return entry.itemId === visibleAnswer?.itemId ? [visibleAnswer] : []
        }
        return entry.kind === "turn_terminal" ||
          entry.kind === "compaction" ||
          (entry.kind === "assistant" && entry.refusal) ||
          (entry.kind === "permission" && entry.state !== "resolved") ||
          (entry.kind === "tool" &&
            entry.execution.name === "request_user_input_async" &&
            !entry.resultError &&
            parseUserQuestions(entry.output) !== undefined)
          ? [entry]
          : []
      })
      const reasoning = entries.filter(
        (entry): entry is Extract<ExecutionEntry, { kind: "reasoning" }> =>
          entry.kind === "reasoning",
      )
      const timeline = groupConversationActivity(
        entries.filter(
          (entry) =>
            entry.kind !== "reasoning" ||
            entry.representation === "redacted" ||
            entry.incomplete ||
            entry.text.trim().length > 0,
        ),
      ).filter(
        // Persistent cards retain their original batch boundary even when
        // rendered outside the process disclosure so they stay actionable.
        (item) =>
          item.kind === "batch" ||
          (!persistent.includes(item.entry) &&
            !(
              item.entry.kind === "assistant" &&
              answerItemIds.has(item.entry.itemId)
            )),
      )
      return { visibleAnswer, persistent, reasoning, timeline }
    }, [entries, answer])
    const currentSummary = active
      ? reasoning
          .filter((entry) => entry.representation === "summary")
          .flatMap((entry) =>
            reasoningSections(entry.text).map((section) => section.summary),
          )
          .findLast((summary) => summary !== undefined && summary !== "")
      : undefined
    // Live activity is visible, but completion starts with the process closed.
    const expanded = completed ? activityExpanded : !liveActivityCollapsed
    const hasEncryptedReasoning = reasoning.some(
      (entry) => entry.representation === "redacted",
    )
    const hasDeferredActivity =
      activityPage !== undefined && activityPage !== "loaded"
    const hasDisclosure = timeline.length > 0 || hasDeferredActivity
    const [loadingActivity, setLoadingActivity] = useState(false)
    const [activityError, setActivityError] = useState<string>()
    const loadActivity = useCallback(async () => {
      setActivityError(undefined)
      setLoadingActivity(true)
      try {
        await (loadTurnActivity ?? useAppStore.getState().loadTurnActivity)(
          turnId,
        )
      } catch (error) {
        setActivityError(
          error instanceof Error ? error.message : "Could not load activity.",
        )
      } finally {
        setLoadingActivity(false)
      }
    }, [turnId, loadTurnActivity])
    useEffect(() => {
      if (
        expanded &&
        activityPage === "unloaded" &&
        !loadingActivity &&
        activityError === undefined
      )
        void loadActivity()
    }, [expanded, activityPage, loadingActivity, activityError, loadActivity])
    const activityLabel = (
      <TurnActivityLabel
        id={labelId}
        active={active}
        timing={timing}
        retry={retry}
      />
    )
    const timelineContent = useMemo(
      () =>
        timeline.length > 0 ? (
          <ol className="agent-timeline" aria-label="Agent activity">
            {timeline.map((item) => (
              <li
                key={
                  item.kind === "batch"
                    ? item.id
                    : executionEntryKey(item.entry)
                }
                className="agent-timeline-item"
                data-kind={item.kind === "batch" ? "batch" : item.entry.kind}
              >
                {item.kind === "batch" ? (
                  <ActivityBatch entries={item.entries} />
                ) : (
                  <EntryCell entry={item.entry} />
                )}
              </li>
            ))}
          </ol>
        ) : null,
      [timeline],
    )
    return (
      <section
        className="conversation-response"
        aria-label={active ? "Current response" : "Response"}
      >
        {entries.length > 0 || active || hasDisclosure ? (
          <div>
            <div className="turn-activity-header" data-completed={completed}>
              {hasDisclosure ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={contentId}
                  aria-labelledby={labelId}
                  onClick={() =>
                    completed
                      ? setActivityExpanded(!activityExpanded)
                      : setLiveActivityCollapsed(!liveActivityCollapsed)
                  }
                  className="flex shrink-0 items-center gap-1.5 text-left hover:text-foreground"
                >
                  {activityLabel}
                  <ChevronRight
                    className={cn(
                      "size-3.5 transition-transform duration-150",
                      expanded && "rotate-90",
                    )}
                  />
                </button>
              ) : (
                activityLabel
              )}
              {currentSummary && !expanded ? (
                <span className="min-w-0 truncate" title={currentSummary}>
                  · {currentSummary}
                </span>
              ) : null}
              {!expanded && hasEncryptedReasoning ? (
                <span
                  className="min-w-0 truncate"
                  title={encryptedReasoningLabel}
                >
                  · {encryptedReasoningLabel}
                </span>
              ) : null}
              {retry ? (
                <Tooltip>
                  <TooltipTrigger
                    type="button"
                    aria-label="Retry details"
                    className="inline-flex items-center hover:text-foreground"
                  >
                    <Info className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm">
                    {retry.message}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            {!hasDisclosure ? null : (
              // Promoted answers leave this cached tree before it closes.
              <TranscriptDisclosureContent
                id={contentId}
                open={expanded}
                className="conversation-disclosure"
                refreshWhenClosed={completed}
              >
                <div className="conversation-activity-content">
                  {loadingActivity ? (
                    <p role="status">Loading activity…</p>
                  ) : null}
                  {activityError ? <p role="alert">{activityError}</p> : null}
                  {!hasDeferredActivity ||
                  loadingActivity ||
                  (activityPage === "unloaded" &&
                    activityError === undefined) ? null : (
                    <button
                      className="text-caption text-muted-foreground"
                      type="button"
                      onClick={() => void loadActivity()}
                    >
                      {activityError === undefined
                        ? "Load earlier activity"
                        : "Retry"}
                    </button>
                  )}
                  {timelineContent}
                </div>
              </TranscriptDisclosureContent>
            )}
          </div>
        ) : null}
        {persistent.map((entry) => (
          <EntryCell key={executionEntryKey(entry)} entry={entry} />
        ))}
        {completed && visibleAnswer ? (
          <ResponseActions
            text={visibleAnswer.text}
            at={timing?.completedAt ?? visibleAnswer.at}
          />
        ) : null}
      </section>
    )
  },
  (previous, next) =>
    previous.activityPage === next.activityPage &&
    previous.blockKey === next.blockKey &&
    previous.active === next.active &&
    previous.timing === next.timing &&
    previous.finalAnswer === next.finalAnswer &&
    previous.presentLiveAnswer === next.presentLiveAnswer &&
    previous.canPreviewUnmarkedAnswer === next.canPreviewUnmarkedAnswer &&
    previous.retry === next.retry &&
    // Grouping creates new arrays on each delta; the reducer preserves entries
    // outside the changed item. Keep completed turns out of the render path.
    previous.entries.length === next.entries.length &&
    previous.entries.every((entry, index) => entry === next.entries[index]),
)

const EntryCell = memo(function EntryCell({
  entry,
}: Readonly<{ entry: ExecutionEntry }>) {
  const { workspaceRoot, sessionId, apiBase } = useConversationScope()
  const openAgent = async (agentId: string) => {
    if (sessionId) useWorkspaceStore.getState().openAgents(sessionId, agentId)
  }
  switch (entry.kind) {
    case "agent_input":
      return <AgentMessageCell entry={entry} sessionId={sessionId} />
    case "assistant":
      return (
        <AssistantMessageCell
          entry={entry}
          workspaceRoot={workspaceRoot}
          sessionId={sessionId}
          apiBase={apiBase}
        />
      )
    case "reasoning":
      return (
        <ReasoningCell
          entry={entry}
          workspaceRoot={workspaceRoot}
          apiBase={apiBase}
        />
      )
    case "plan":
      return <PlanCell plan={entry.plan} />
    case "compaction":
      return <CompactionCell entry={entry} />
    case "tool":
      return (
        <ToolCell
          entry={entry}
          workspaceRoot={workspaceRoot}
          onOpenSession={openAgent}
          apiBase={apiBase}
        />
      )
    case "hosted_tool":
      return <HostedToolCell tool={entry.tool} />
    case "permission":
      return <PermissionCell entry={entry} />
    case "turn_terminal":
      return <TurnTerminalCell entry={entry} />
    case "user_input":
      return <UserMessageCell entry={entry} queued={false} />
  }
})
