import { ArrowDown, ChevronRight, Info } from "lucide-react"
import {
  memo,
  type ReactNode,
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
  type TurnTiming,
} from "../execution-view.ts"
import { ConversationScrollContext } from "../hooks/conversation-scroll-context.ts"
import { usePinnedScroll } from "../hooks/use-pinned-scroll.ts"
import { cn } from "../lib/utils.ts"
import {
  selectCurrentThreadId,
  useAppStore,
  useExecutionView,
} from "../store/app-store.ts"
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
import { ConversationFind } from "./conversation-find.tsx"
import { ConversationNavigation } from "./conversation-navigation.tsx"
import {
  type ContextSourceNavigation,
  findContextSource,
  revealContextSourceEvent,
} from "./excerpt-source.tsx"
import { reasoningSections } from "./reasoning-trace.tsx"
import { ResponseActions } from "./response-actions.tsx"
import { SessionElicitation } from "./session-elicitation.tsx"
import { TranscriptDisclosureContent } from "./transcript-disclosure.tsx"
import { TurnActivityLabel } from "./turn-activity-label.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import "./activity-timeline.css"

// Keep admission order, including queued/steering inputs between turn items.
// Only adjacent items of the same turn share a disclosure.
type TranscriptBlock = {
  key: string
  turnId: string | undefined
  entries: readonly ExecutionEntry[]
}

function containsMessageSource(
  entries: readonly ExecutionEntry[],
  messageId: string,
): boolean {
  return entries.some((entry) =>
    entry.kind === "user_input" || entry.kind === "agent_input"
      ? entry.inputId === messageId
      : entry.kind === "assistant" && entry.itemId === messageId,
  )
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

export function Transcript({
  children,
  emptyState,
  loading = false,
}: Readonly<{
  children?: ReactNode
  emptyState?: ReactNode
  loading?: boolean
}>) {
  const view = useExecutionView()
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const historyRevision = useAppStore((state) =>
    sessionId === undefined
      ? 0
      : (state.sessionHistoryRevisions[sessionId] ?? 0),
  )
  const historyBefore = useAppStore((state) => state.historyBefore)
  const loadEarlierHistory = useAppStore((state) => state.loadEarlierHistory)
  const loadHistoryThrough = useAppStore((state) => state.loadHistoryThrough)
  const historyLoading = useAppStore((state) =>
    state.inFlightActions.has(`history:${state.selection.sessionId}`),
  )
  const hydrating = useAppStore(
    (state) => state.hydratingSessionId === state.selection.sessionId,
  )
  const threadId = useAppStore(selectCurrentThreadId)
  const scroll = usePinnedScroll(threadId, historyRevision)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [visibleInputs, setVisibleInputs] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const previousBlocks = useRef<readonly TranscriptBlock[]>([])
  const previousScope = useRef({ sessionId, historyRevision })
  const previousAnswers = useRef(new Map<string, FinalAnswer>())
  const selectionRevision = useAppStore(
    (state) => state.sessionSelectionIntentRevision,
  )
  const loadingEarlier = useRef<
    | Readonly<{
        sessionId: string
        selectionRevision: number
        historyRevision: number
      }>
    | undefined
  >(undefined)
  const earlierAnchor = useRef<
    | Readonly<{
        request: object
        sessionId: string
        selectionRevision: number
        historyRevision: number
        before: number
        node: Element
        top: number
      }>
    | undefined
  >(undefined)
  const previousScrollTop = useRef(0)
  const previousTouchY = useRef<number | undefined>(undefined)
  const [pendingSource, setPendingSource] = useState<
    | Readonly<{
        navigation: ContextSourceNavigation
        selectionRevision: number
        historyRevision: number
      }>
    | undefined
  >(undefined)
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
  const inputs = view.entries
    .filter(
      (entry) => entry.kind === "user_input" || entry.kind === "agent_input",
    )
    .filter((entry) => !entry.steered)
  const inputIds = inputs.map((entry) => entry.inputId).join("\0")
  const queued = new Set(view.queuedInputIds)
  useEffect(() => {
    const revealSource = (event: Event) => {
      const navigation = (event as CustomEvent<ContextSourceNavigation>).detail
      const source = navigation.source
      const state = useAppStore.getState()
      if (
        source.kind !== "message" ||
        source.sessionId !== state.selection.sessionId ||
        containsMessageSource(state.execution.entries, source.messageId)
      )
        return
      setPendingSource({
        navigation,
        selectionRevision: state.sessionSelectionIntentRevision,
        historyRevision: state.sessionHistoryRevisions[source.sessionId] ?? 0,
      })
    }
    window.addEventListener(revealContextSourceEvent, revealSource)
    return () =>
      window.removeEventListener(revealContextSourceEvent, revealSource)
  }, [])
  useEffect(() => {
    if (!pendingSource) return
    const { navigation } = pendingSource
    const source = navigation.source
    if (
      source.kind !== "message" ||
      source.sessionId !== sessionId ||
      pendingSource.selectionRevision !== selectionRevision ||
      pendingSource.historyRevision !== historyRevision
    ) {
      setPendingSource(undefined)
      return
    }
    if (containsMessageSource(view.entries, source.messageId)) {
      // The new TurnBlock must mount its disclosure listener before retrying.
      const frame = requestAnimationFrame(() => {
        const state = useAppStore.getState()
        if (
          state.selection.sessionId !== source.sessionId ||
          state.sessionSelectionIntentRevision !==
            pendingSource.selectionRevision ||
          (state.sessionHistoryRevisions[source.sessionId] ?? 0) !==
            pendingSource.historyRevision
        )
          return
        setPendingSource(undefined)
        const target = findContextSource(source)
        if (target) target.scrollIntoView(navigation.options)
        else
          window.dispatchEvent(
            new CustomEvent(revealContextSourceEvent, { detail: navigation }),
          )
      })
      return () => cancelAnimationFrame(frame)
    }
    if (!historyLoading && historyBefore !== undefined) {
      void loadHistoryThrough(source.messageId).then((found) => {
        const state = useAppStore.getState()
        if (
          !found &&
          !state.inFlightActions.has(`history:${source.sessionId}`) &&
          !containsMessageSource(state.execution.entries, source.messageId)
        )
          setPendingSource((current) =>
            current === pendingSource ? undefined : current,
          )
      })
    } else if (!historyLoading) {
      setPendingSource(undefined)
    }
  }, [
    pendingSource,
    sessionId,
    selectionRevision,
    historyRevision,
    view.entries,
    historyLoading,
    historyBefore,
    loadHistoryThrough,
  ])
  // A message counts as in view while its turn segment — from its own bubble
  // to the next bubble — intersects the viewport, like codex's rail. Only
  // those markers take the active color; there is no default selection.
  const updateVisibleInputs = useCallback(() => {
    const viewport = scroll.viewportRef.current
    if (!viewport) return
    const { top, bottom } = viewport.getBoundingClientRect()
    const tops = (inputIds === "" ? [] : inputIds.split("\0")).map(
      (inputId) => ({
        inputId,
        top: anchors.current.get(inputId)?.getBoundingClientRect().top,
      }),
    )
    const next = new Set<string>()
    tops.forEach((entry, index) => {
      if (entry.top === undefined) return
      const end = tops[index + 1]?.top ?? Number.POSITIVE_INFINITY
      if (entry.top < bottom && end > top) next.add(entry.inputId)
    })
    setVisibleInputs((previous) =>
      previous.size === next.size && [...next].every((id) => previous.has(id))
        ? previous
        : next,
    )
  }, [inputIds, scroll.viewportRef])
  const requestEarlierHistory = () => {
    const viewport = scroll.viewportRef.current
    if (
      !viewport ||
      sessionId === undefined ||
      hydrating ||
      historyBefore === undefined ||
      loadingEarlier.current ||
      viewport.scrollTop > 48
    ) {
      return
    }
    const request = { sessionId, selectionRevision, historyRevision }
    loadingEarlier.current = request
    void loadEarlierHistory({
      beforePrepend: () => {
        const state = useAppStore.getState()
        if (
          loadingEarlier.current !== request ||
          state.selection.sessionId !== sessionId ||
          state.sessionSelectionIntentRevision !== selectionRevision ||
          (state.sessionHistoryRevisions[sessionId] ?? 0) !== historyRevision
        )
          return
        const node = scroll.contentRef.current?.firstElementChild
        if (!node) return
        scroll.pauseFollowing()
        // Capture immediately before the store commits the prepend. Streaming
        // and user scrolling while the request was pending belong to this view.
        earlierAnchor.current = {
          request,
          sessionId,
          selectionRevision,
          historyRevision,
          before: historyBefore,
          node,
          top: node.getBoundingClientRect().top,
        }
      },
    }).then((loaded) => {
      if (!loaded && earlierAnchor.current?.request === request)
        earlierAnchor.current = undefined
      if (loadingEarlier.current === request) loadingEarlier.current = undefined
    })
  }
  const updateScroll = () => {
    scroll.onScroll()
    updateVisibleInputs()
    const viewport = scroll.viewportRef.current
    if (!viewport) return
    const upward = viewport.scrollTop < previousScrollTop.current
    previousScrollTop.current = viewport.scrollTop
    if (upward) requestEarlierHistory()
  }
  useLayoutEffect(() => {
    const saved = earlierAnchor.current
    const viewport = scroll.viewportRef.current
    if (!saved || !viewport) return
    if (
      saved.sessionId !== sessionId ||
      saved.selectionRevision !== selectionRevision ||
      saved.historyRevision !== historyRevision
    ) {
      earlierAnchor.current = undefined
      return
    }
    if (historyBefore === saved.before) return
    earlierAnchor.current = undefined
    if (!scroll.contentRef.current?.contains(saved.node)) return
    viewport.scrollTop += saved.node.getBoundingClientRect().top - saved.top
    previousScrollTop.current = viewport.scrollTop
    scroll.onScroll()
  }, [
    historyBefore,
    sessionId,
    selectionRevision,
    historyRevision,
    scroll.contentRef,
    scroll.viewportRef,
    scroll.onScroll,
  ])
  useLayoutEffect(() => {
    if (
      loadingEarlier.current?.sessionId !== sessionId ||
      loadingEarlier.current?.selectionRevision !== selectionRevision ||
      loadingEarlier.current?.historyRevision !== historyRevision
    ) {
      loadingEarlier.current = undefined
      earlierAnchor.current = undefined
      previousScrollTop.current = scroll.viewportRef.current?.scrollTop ?? 0
      previousTouchY.current = undefined
    }
  }, [sessionId, selectionRevision, historyRevision, scroll.viewportRef])
  // Streaming text changes entries but does not move input anchors. Measure
  // those only when the set of visible input anchors changes or on scroll.
  useLayoutEffect(updateVisibleInputs, [updateVisibleInputs])
  useLayoutEffect(() => {
    const content = scroll.contentRef.current
    if (!content) return
    const observer = new ResizeObserver(updateVisibleInputs)
    observer.observe(content)
    return () => observer.disconnect()
  }, [scroll.contentRef, updateVisibleInputs])
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    const dock = dockRef.current
    if (!surface || !dock) return
    const updateDockHeight = () => {
      surface.style.setProperty(
        "--conversation-dock-height",
        `${Math.ceil(dock.getBoundingClientRect().height)}px`,
      )
      scroll.onLayoutChange()
    }
    updateDockHeight()
    const observer = new ResizeObserver(updateDockHeight)
    observer.observe(dock)
    return () => {
      observer.disconnect()
      surface.style.removeProperty("--conversation-dock-height")
    }
  }, [scroll.onLayoutChange])

  return (
    <ConversationScrollContext.Provider value={scroll}>
      <div
        ref={surfaceRef}
        className="conversation-surface relative flex min-h-0 flex-1"
        data-empty={emptyState !== undefined || undefined}
      >
        {sessionId && !loading ? (
          <ConversationFind
            key={sessionId}
            sessionId={sessionId}
            contentRef={scroll.contentRef}
            onJump={scroll.jumpToFindMatch}
          />
        ) : null}
        <ScrollArea
          className={cn(
            "min-h-0 min-w-0 flex-1",
            emptyState !== undefined && "hidden",
          )}
          viewportClassName="conversation-transcript-viewport"
          viewportRef={scroll.viewportRef}
          onScroll={updateScroll}
          onWheel={(event) => {
            if (event.deltaY < 0) requestEarlierHistory()
          }}
          onTouchStart={(event) => {
            previousTouchY.current = event.touches[0]?.clientY
          }}
          onTouchMove={(event) => {
            const y = event.touches[0]?.clientY
            if (
              y !== undefined &&
              previousTouchY.current !== undefined &&
              y > previousTouchY.current
            )
              requestEarlierHistory()
            previousTouchY.current = y
          }}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              (event.target instanceof HTMLElement &&
                (event.target.isContentEditable ||
                  event.target.closest("input, textarea, select")))
            )
              return
            if (["ArrowUp", "PageUp", "Home"].includes(event.key))
              requestEarlierHistory()
          }}
        >
          <div
            ref={scroll.contentRef}
            className="conversation-content mx-auto flex w-full flex-col"
          >
            {loading ? (
              <p
                role="status"
                className="py-12 text-center text-sm text-muted-foreground"
              >
                Loading conversation…
              </p>
            ) : view.entries.length === 0 && view.activeTurnId === undefined ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Conversation will appear here
              </p>
            ) : (
              blocks.map((block, index) => {
                const first = block.entries[0]
                if (
                  first?.kind === "user_input" ||
                  first?.kind === "agent_input"
                )
                  return (
                    <div
                      key={block.key}
                      ref={(node) => {
                        if (node) anchors.current.set(first.inputId, node)
                        else anchors.current.delete(first.inputId)
                      }}
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
                    retry={
                      index === activeBlockIndex ? view.activeRetry : undefined
                    }
                  />
                ) : (
                  block.entries.map((entry) => (
                    <EntryCell key={executionEntryKey(entry)} entry={entry} />
                  ))
                )
              })
            )}
            {!loading &&
            view.activeTurnId !== undefined &&
            activeBlockIndex === -1 ? (
              <TurnBlock
                key={`${historyRevision}:${view.activeTurnId}`}
                entries={[]}
                active
                timing={view.turnTimings[view.activeTurnId]}
                finalAnswer={undefined}
                retry={view.activeRetry}
              />
            ) : null}
          </div>
        </ScrollArea>
        {loading ? null : (
          <ConversationNavigation
            entries={view.entries}
            visibleInputs={visibleInputs}
            viewportRef={scroll.viewportRef}
            contentRef={scroll.contentRef}
            onJump={(inputId) => {
              const node = anchors.current.get(inputId)
              if (node) scroll.jumpToElement(node)
            }}
          />
        )}
        {
          <button
            type="button"
            aria-label="Jump to latest output"
            onClick={scroll.jumpToBottom}
            data-visible={!scroll.atBottom}
            tabIndex={scroll.atBottom ? -1 : 0}
            aria-hidden={scroll.atBottom}
            className="conversation-jump"
          >
            <ArrowDown className="size-5" />
          </button>
        }
        {children === undefined ? null : (
          <div ref={dockRef} className="conversation-dock">
            {emptyState}
            <div className="max-h-[45vh] overflow-y-auto">
              {loading ? null : <SessionElicitation />}
            </div>
            {children}
          </div>
        )}
      </div>
    </ConversationScrollContext.Provider>
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
    const threadId = useAppStore(selectCurrentThreadId)
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
          source.sessionId !== useAppStore.getState().selection.sessionId ||
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
    }, [entries, setActivityExpanded, setLiveActivityCollapsed])
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
  const workspaceRoot = useAppStore((state) => state.execution.workingDirectory)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const apiBase = useAppStore((state) => state.apiBase)
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
      return <ReasoningCell entry={entry} workspaceRoot={workspaceRoot} />
    case "tool":
      return (
        <ToolCell
          entry={entry}
          workspaceRoot={workspaceRoot}
          onOpenSession={openAgent}
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
