import { ArrowDown, ChevronRight, Info, Wrench } from "lucide-react"
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
import type {
  ActiveModelRetry,
  ExecutionEntry,
  TurnTiming,
} from "../execution-view.ts"
import { ConversationScrollContext } from "../hooks/conversation-scroll-context.ts"
import { usePinnedScroll } from "../hooks/use-pinned-scroll.ts"
import { formatElapsed } from "../lib/format.ts"
import { cn } from "../lib/utils.ts"
import { useAppStore, useExecutionView } from "../store/app-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { presentTool } from "../tool-presentation.ts"
import { AssistantMessageCell } from "./cells/assistant-message-cell.tsx"
import { LiveTextNotice } from "./cells/live-text-notice.tsx"
import { PermissionCell } from "./cells/permission-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { ToolCell } from "./cells/tool-cell.tsx"
import { TurnTerminalCell } from "./cells/turn-terminal-cell.tsx"
import { UserMessageCell } from "./cells/user-message-cell.tsx"
import { ConversationFind } from "./conversation-find.tsx"
import { ConversationNavigation } from "./conversation-navigation.tsx"
import { MarkdownView } from "./markdown.tsx"
import { ResponseActions } from "./response-actions.tsx"
import { SessionElicitation } from "./session-elicitation.tsx"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx"
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
    else blocks.push({ key: entryKey(entry), turnId, entries: [entry] })
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

function entryKey(entry: ExecutionEntry): string {
  switch (entry.kind) {
    case "user_input":
      return entry.inputId
    case "assistant":
    case "reasoning":
      return entry.itemId
    case "tool":
      return entry.toolCallId
    case "permission":
      return entry.permissionRequestId
    case "turn_terminal":
      return `${entry.turnId}:${entry.state}`
  }
}

export function Transcript({ children }: Readonly<{ children?: ReactNode }>) {
  const view = useExecutionView()
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const scroll = usePinnedScroll(sessionId)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [visibleInputs, setVisibleInputs] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const previousBlocks = useRef<readonly TranscriptBlock[]>([])
  const previousSessionId = useRef(sessionId)
  const blocks = useMemo(() => {
    if (previousSessionId.current !== sessionId) {
      previousBlocks.current = []
      previousSessionId.current = sessionId
    }
    const next = groupEntries(view.entries, previousBlocks.current)
    previousBlocks.current = next
    return next
  }, [sessionId, view.entries])
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
  const previousAnswers = useRef(new Map<string, FinalAnswer>())
  const finalAnswers = useMemo(() => {
    const turns = new Map<
      string,
      { last: ExecutionEntry | undefined; failed: boolean }
    >()
    const assistants = new Map<
      string,
      Extract<ExecutionEntry, { kind: "assistant" }>
    >()
    for (const entry of view.entries) {
      if (!("turnId" in entry)) continue
      const turn = turns.get(entry.turnId) ?? { last: undefined, failed: false }
      if (entry.kind === "turn_terminal") {
        turn.failed = ["failed", "cancelled", "interrupted"].includes(
          entry.state,
        )
      } else if (entry.kind !== "permission") turn.last = entry
      if (entry.kind === "assistant") assistants.set(entry.itemId, entry)
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
            ? [turn.last.itemId]
            : []
      const pieces = itemIds.flatMap((id) => {
        const entry = assistants.get(id)
        return entry?.turnId === turnId ? [entry] : []
      })
      const last = pieces.at(-1)
      if (last === undefined || pieces.length !== itemIds.length) continue
      const text = pieces.map((entry) => entry.text).join("")
      const incomplete = pieces.some((entry) => entry.incomplete)
      const previous = previousAnswers.current.get(turnId)
      answers.set(
        turnId,
        previous?.entry.itemId === last.itemId &&
          previous.entry.text === text &&
          previous.entry.at === last.at &&
          previous.entry.status === last.status &&
          previous.entry.incomplete === incomplete &&
          previous.itemIds.length === itemIds.length &&
          previous.itemIds.every((id, index) => id === itemIds[index])
          ? previous
          : { itemIds, entry: { ...last, text, incomplete } },
      )
    }
    previousAnswers.current = answers
    return answers
  }, [view.entries, view.turnTimings, view.activeTurnId])
  const inputs = view.entries
    .filter((entry) => entry.kind === "user_input")
    .filter((entry) => !entry.steered)
  const inputIds = inputs.map((entry) => entry.inputId).join("\0")
  const queued = new Set(view.queuedInputIds)
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
  const updateScroll = () => {
    scroll.onScroll()
    updateVisibleInputs()
  }
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
      >
        {sessionId ? (
          <ConversationFind
            key={sessionId}
            sessionId={sessionId}
            contentRef={scroll.contentRef}
            onJump={scroll.jumpToFindMatch}
          />
        ) : null}
        <ScrollArea
          className="min-h-0 min-w-0 flex-1"
          viewportClassName="conversation-transcript-viewport"
          viewportRef={scroll.viewportRef}
          onScroll={updateScroll}
        >
          <div
            ref={scroll.contentRef}
            className="conversation-content mx-auto flex w-full flex-col gap-8 pt-8"
          >
            {view.entries.length === 0 && view.activeTurnId === undefined ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Conversation will appear here
              </p>
            ) : (
              blocks.map((block, index) => {
                const first = block.entries[0]
                if (first?.kind === "user_input")
                  return (
                    <div
                      key={block.key}
                      ref={(node) => {
                        if (node) anchors.current.set(first.inputId, node)
                        else anchors.current.delete(first.inputId)
                      }}
                    >
                      <UserMessageCell
                        entry={first}
                        queued={queued.has(first.inputId)}
                      />
                    </div>
                  )
                return block.turnId ? (
                  <TurnBlock
                    key={block.key}
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
                    <EntryCell key={entryKey(entry)} entry={entry} />
                  ))
                )
              })
            )}
            {view.activeTurnId !== undefined && activeBlockIndex === -1 ? (
              <TurnBlock
                key={view.activeTurnId}
                entries={[]}
                active
                timing={view.turnTimings[view.activeTurnId]}
                finalAnswer={undefined}
                retry={view.activeRetry}
              />
            ) : null}
          </div>
        </ScrollArea>
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
            <div className="max-h-[45vh] overflow-y-auto">
              <SessionElicitation />
            </div>
            {children}
          </div>
        )}
      </div>
    </ConversationScrollContext.Provider>
  )
}

type FinalAnswer = Readonly<{
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
    const [reasoningExpanded, setReasoningExpanded] = useState(false)
    const contentId = useId()
    const workspaceRoot = useAppStore(
      (state) => state.execution.workingDirectory,
    )
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
        (entry.kind === "permission" && entry.state !== "resolved")
        ? [entry]
        : []
    })
    const reasoning = entries.filter(
      (entry): entry is Extract<ExecutionEntry, { kind: "reasoning" }> =>
        entry.kind === "reasoning",
    )
    const timeline = groupTurnTimeline(
      entries.filter(
        (entry) =>
          !persistent.includes(entry) &&
          entry.kind !== "reasoning" &&
          !(entry.kind === "assistant" && answerItemIds.has(entry.itemId)),
      ),
    )
    const reasoningText = reasoning
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join("\n\n")
    const seconds =
      timing?.startedAt && timing.completedAt
        ? Math.max(
            0,
            Math.floor(
              (Date.parse(timing.completedAt) - Date.parse(timing.startedAt)) /
                1000,
            ),
          )
        : undefined
    const retryLabel =
      retry?.kind === "rate_limited"
        ? "Waiting for rate limit"
        : retry?.kind === "connection_failed" ||
            retry?.kind === "stream_disconnected" ||
            retry?.kind === "idle_timeout"
          ? "Reconnecting"
          : "Retrying request"
    const activityLabel = (
      <span
        className={active ? "tool-running-label" : undefined}
        role={active ? "status" : undefined}
      >
        {retry
          ? `${retryLabel} · attempt ${retry.nextAttempt}/${retry.maxAttempts}`
          : active
            ? "Working"
            : seconds === undefined
              ? "Activity"
              : `Worked for ${formatElapsed(seconds)}`}
      </span>
    )
    return (
      <section
        className="flex flex-col gap-5"
        aria-label={active ? "Current response" : "Response"}
      >
        {entries.length > 0 || active ? (
          <div>
            <div
              className={cn(
                "flex items-center gap-1.5 text-left text-[14px] text-muted-foreground",
                finalAnswer ? "border-b pb-3" : "pb-1",
              )}
            >
              {reasoningText !== "" ? (
                <button
                  type="button"
                  aria-expanded={reasoningExpanded}
                  aria-controls={contentId}
                  onClick={() => setReasoningExpanded(!reasoningExpanded)}
                  className="flex items-center gap-1.5 text-left hover:text-foreground"
                >
                  {activityLabel}
                  <ChevronRight
                    className={cn(
                      "size-3.5 transition-transform duration-150",
                      reasoningExpanded && "rotate-90",
                    )}
                  />
                </button>
              ) : (
                activityLabel
              )}
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
            {reasoningText === "" ? null : (
              <div
                id={contentId}
                className="conversation-disclosure"
                data-expanded={reasoningExpanded}
                aria-hidden={!reasoningExpanded}
                inert={!reasoningExpanded}
              >
                <div className="min-h-0 overflow-hidden">
                  {reasoningExpanded ? (
                    <>
                      {entries
                        .filter(
                          (entry) =>
                            entry.kind === "reasoning" && entry.incomplete,
                        )
                        .slice(0, 1)
                        .map((entry) =>
                          entry.kind === "reasoning" ? (
                            <LiveTextNotice key={entry.itemId} entry={entry} />
                          ) : null,
                        )}
                      <MarkdownView
                        text={reasoningText}
                        streaming={active}
                        className="markdown max-w-2xl pt-4 text-sm text-muted-foreground"
                        workspaceRoot={workspaceRoot}
                      />
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        ) : null}
        {timeline.length > 0 ? (
          <ol className="agent-timeline" aria-label="Agent activity">
            {timeline.map((item) => (
              <li
                key={entryKey(
                  item.kind === "entry" ? item.entry : item.entries[0],
                )}
                className="agent-timeline-item"
                data-kind={item.kind === "entry" ? item.entry.kind : "actions"}
              >
                {item.kind === "entry" ? (
                  <EntryCell entry={item.entry} />
                ) : (
                  <ActionGroup entries={item.entries} />
                )}
              </li>
            ))}
          </ol>
        ) : null}
        {persistent.map((entry) => (
          <EntryCell key={entryKey(entry)} entry={entry} />
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

type TurnTimelineItem =
  | { readonly kind: "entry"; readonly entry: ExecutionEntry }
  | {
      readonly kind: "actions"
      readonly entries: readonly [ExecutionEntry, ...ExecutionEntry[]]
    }

function groupTurnTimeline(
  entries: readonly ExecutionEntry[],
): readonly TurnTimelineItem[] {
  const timeline: TurnTimelineItem[] = []
  let actions: ExecutionEntry[] = []
  const flushActions = () => {
    const [first, ...rest] = actions
    if (first === undefined) return
    timeline.push({ kind: "actions", entries: [first, ...rest] })
    actions = []
  }
  for (const entry of entries) {
    if (
      (entry.kind === "tool" &&
        entry.execution.type !== "collaboration_tool_call" &&
        entry.execution.name !== "request_user_input_async") ||
      entry.kind === "permission"
    ) {
      actions.push(entry)
      continue
    }
    flushActions()
    timeline.push({ kind: "entry", entry })
  }
  flushActions()
  return timeline
}

function ActionGroup({
  entries,
}: Readonly<{ entries: readonly ExecutionEntry[] }>) {
  const workspaceRoot = useAppStore((state) => state.execution.workingDirectory)
  const tools = entries.filter(
    (entry): entry is Extract<ExecutionEntry, { kind: "tool" }> =>
      entry.kind === "tool",
  )
  const active = tools.some((entry) => entry.state === "requested")
  const failed = tools.some((entry) => entry.state === "failed")
  const interrupted = tools.some((entry) => entry.state === "interrupted")
  const hasProblem = failed || interrupted
  const [open, setOpen] = useState(hasProblem)
  useEffect(() => {
    if (hasProblem) setOpen(true)
  }, [hasProblem])
  const verbCounts = new Map<string, number>()
  for (const tool of tools) {
    const verb = presentTool(tool, workspaceRoot).verb
    verbCounts.set(verb, (verbCounts.get(verb) ?? 0) + 1)
  }
  const summary = [
    ...[...verbCounts].map(([verb, count]) =>
      count === 1 ? verb : `${verb} ${count}`,
    ),
    ...(entries.some((entry) => entry.kind === "permission")
      ? ["Approval"]
      : []),
  ].join(" · ")

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/actions">
      <CollapsibleTrigger
        className={cn(
          "flex max-w-full items-center gap-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground",
          hasProblem && "text-destructive hover:text-destructive",
        )}
      >
        <Wrench className="size-4 shrink-0" />
        <span className={cn(active && "tool-running-label")}>
          {failed
            ? "Tool failed"
            : interrupted
              ? "Tool interrupted"
              : active
                ? "Using tools"
                : "Used tools"}
        </span>
        {summary === "" ? null : (
          <span
            className={cn(
              "min-w-0 truncate text-muted-foreground/80",
              hasProblem && "text-destructive/80",
            )}
          >
            · {summary}
          </span>
        )}
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/actions:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="flex flex-col gap-1 pl-3">
          {entries.map((entry) => (
            <EntryCell key={entryKey(entry)} entry={entry} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const EntryCell = memo(function EntryCell({
  entry,
}: Readonly<{ entry: ExecutionEntry }>) {
  const workspaceRoot = useAppStore((state) => state.execution.workingDirectory)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const openAgent = async (agentId: string) => {
    if (sessionId) useWorkspaceStore.getState().openAgents(sessionId, agentId)
  }
  switch (entry.kind) {
    case "assistant":
      return (
        <AssistantMessageCell entry={entry} workspaceRoot={workspaceRoot} />
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
