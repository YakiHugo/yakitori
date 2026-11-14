import { ChevronRight, Info } from "lucide-react"
import {
  memo,
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
  type TurnTiming,
} from "../execution-view.ts"
import { cn } from "../lib/utils.ts"
import { useThreadScopeState } from "../store/thread-scope-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { ActivityBatch } from "./activity-batch.tsx"
import { AgentMessageCell } from "./cells/agent-message-cell.tsx"
import { AssistantMessageCell } from "./cells/assistant-message-cell.tsx"
import { PermissionCell } from "./cells/permission-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { ToolCell } from "./cells/tool-cell.tsx"
import { TurnTerminalCell } from "./cells/turn-terminal-cell.tsx"
import { UserMessageCell } from "./cells/user-message-cell.tsx"
import {
  type ContextSourceNavigation,
  findContextSource,
  revealContextSourceEvent,
} from "./excerpt-source.tsx"
import { reasoningSections } from "./reasoning-trace.tsx"
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
): TranscriptBlock[] {
  const blocks: {
    key: string
    turnId: string | undefined
    entries: ExecutionEntry[]
  }[] = []
  for (const entry of entries) {
    const turnId = "turnId" in entry ? entry.turnId : undefined
    const last = blocks.at(-1)
    if (turnId !== undefined && last?.turnId === turnId)
      last.entries.push(entry)
    else
      blocks.push({ key: executionEntryKey(entry), turnId, entries: [entry] })
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
    const next = groupEntries(view.entries, previousBlocks.current)
    previousBlocks.current = next
    return next
  }, [sessionId, historyRevision, view.entries])
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
      } else if (entry.kind !== "permission") turn.last = entry
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
        .filter((entry) => entry.turnId === turnId)
      const last = pieces.at(-1)
      if (last === undefined) continue
      const text = pieces.map((entry) => entry.text).join("")
      const incomplete = pieces.some((entry) => entry.incomplete)
      const sources = pieces.flatMap((piece) =>
        (piece.sources ?? []).map((source) => ({
          ...source,
          // Citation IDs are local to each recorded assistant item.
          id: JSON.stringify([piece.itemId, source.id]),
        })),
      )
      const previous = previousAnswers.current.get(turnId)
      answers.set(
        turnId,
        previous?.pieces.length === pieces.length &&
          previous.pieces.every((entry, index) => entry === pieces[index])
          ? previous
          : {
              itemIds: pieces.map((piece) => piece.itemId),
              pieces,
              entry: { ...last, text, incomplete, sources },
            },
      )
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
            entries={block.entries}
            active={view.activeTurnId === block.turnId}
            timing={view.turnTimings[block.turnId]}
            finalAnswer={finalAnswers.get(block.turnId)}
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
          entries={[]}
          active
          timing={view.turnTimings[view.activeTurnId]}
          finalAnswer={undefined}
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

const TurnBlock = memo(
  function TurnBlock({
    entries,
    active,
    timing,
    finalAnswer,
    retry,
  }: Readonly<{
    entries: readonly ExecutionEntry[]
    active: boolean
    timing: TurnTiming | undefined
    finalAnswer: FinalAnswer | undefined
    retry: ActiveModelRetry | undefined
  }>) {
    const { threadId, sessionId } = useConversationScope()
    const blockKey = entries[0] ? executionEntryKey(entries[0]) : "active"
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
    const { visibleAnswer, persistent, reasoning, timeline } = useMemo(() => {
      const answerInBlock = entries.some(
        (entry) =>
          entry.kind === "assistant" &&
          entry.itemId === finalAnswer?.entry.itemId,
      )
      const visibleAnswer = answerInBlock ? finalAnswer?.entry : undefined
      const answerItemIds = new Set(finalAnswer?.itemIds)
      const persistent = entries.flatMap<ExecutionEntry>((entry) => {
        if (entry.kind === "assistant" && answerItemIds.has(entry.itemId)) {
          return entry.itemId === visibleAnswer?.itemId ? [visibleAnswer] : []
        }
        return entry.kind === "turn_terminal" ||
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
    }, [entries, finalAnswer])
    const currentSummary = active
      ? reasoning
          .flatMap((entry) =>
            reasoningSections(entry.text).map((section) => section.summary),
          )
          .findLast((summary) => summary !== undefined && summary !== "")
      : undefined
    // Live activity is visible, but completion starts with the process closed.
    const expanded = completed ? activityExpanded : !liveActivityCollapsed
    const hasDisclosure = timeline.length > 0
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
        {entries.length > 0 || active ? (
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
              // Completion moves the final answer outside this cached tree.
              <TranscriptDisclosureContent
                id={contentId}
                open={expanded}
                className="conversation-disclosure"
                refreshWhenClosed={completed}
              >
                <div className="conversation-activity-content">
                  {timelineContent}
                </div>
              </TranscriptDisclosureContent>
            )}
          </div>
        ) : null}
        {persistent.map((entry) => (
          <EntryCell key={executionEntryKey(entry)} entry={entry} />
        ))}
        {visibleAnswer ? (
          <ResponseActions
            text={visibleAnswer.text}
            at={timing?.completedAt ?? visibleAnswer.at}
          />
        ) : null}
      </section>
    )
  },
  (previous, next) =>
    previous.active === next.active &&
    previous.timing === next.timing &&
    previous.finalAnswer === next.finalAnswer &&
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
    case "tool":
      return (
        <ToolCell
          entry={entry}
          workspaceRoot={workspaceRoot}
          onOpenSession={openAgent}
          apiBase={apiBase}
        />
      )
    case "permission":
      return <PermissionCell entry={entry} />
    case "turn_terminal":
      return <TurnTerminalCell entry={entry} />
    case "user_input":
      return <UserMessageCell entry={entry} queued={false} />
  }
})
