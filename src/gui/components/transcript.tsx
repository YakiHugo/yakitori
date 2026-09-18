import { ArrowDown, ChevronRight, Info } from "lucide-react"
import {
  type ReactNode,
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
import { AssistantMessageCell } from "./cells/assistant-message-cell.tsx"
import { CompactionCell } from "./cells/compaction-cell.tsx"
import { PermissionCell } from "./cells/permission-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { ToolCell } from "./cells/tool-cell.tsx"
import { TurnTerminalCell } from "./cells/turn-terminal-cell.tsx"
import { UserMessageCell } from "./cells/user-message-cell.tsx"
import { ResponseActions } from "./response-actions.tsx"
import { ConversationNavigation } from "./conversation-navigation.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

// Keep admission order, including queued/steering inputs between turn items.
// Only adjacent items of the same turn share a disclosure.
function groupEntries(entries: readonly ExecutionEntry[]) {
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
  return blocks
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
    case "context_compacted":
      return entry.compactionId
  }
}

export function Transcript({ children }: Readonly<{ children?: ReactNode }>) {
  const view = useExecutionView()
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const scroll = usePinnedScroll(sessionId)
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [visibleInputs, setVisibleInputs] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const blocks = useMemo(() => groupEntries(view.entries), [view.entries])
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
    for (const entry of view.entries) {
      if (!("turnId" in entry)) continue
      const turn = turns.get(entry.turnId) ?? { last: undefined, failed: false }
      if (entry.kind === "turn_terminal") turn.failed = true
      else if (entry.kind !== "permission") turn.last = entry
      turns.set(entry.turnId, turn)
    }
    const answers = new Map<string, string>()
    for (const [turnId, turn] of turns) {
      // An input can split a turn into several adjacent blocks. Final-answer
      // promotion belongs to the entire completed turn, not each fragment.
      if (
        view.turnTimings[turnId]?.completedAt !== undefined &&
        view.activeTurnId !== turnId &&
        !turn.failed &&
        turn.last?.kind === "assistant"
      )
        answers.set(turnId, turn.last.itemId)
    }
    return answers
  }, [view.entries, view.turnTimings, view.activeTurnId])
  const inputs = view.entries.filter((entry) => entry.kind === "user_input")
  const queued = new Set(view.queuedInputIds)
  // A message counts as in view while its turn segment — from its own bubble
  // to the next bubble — intersects the viewport, like codex's rail. Only
  // those markers take the active color; there is no default selection.
  const updateVisibleInputs = () => {
    const viewport = scroll.viewportRef.current
    if (!viewport) return
    const { top, bottom } = viewport.getBoundingClientRect()
    const tops = inputs.map((input) => ({
      inputId: input.inputId,
      top: anchors.current.get(input.inputId)?.getBoundingClientRect().top,
    }))
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
  }
  const updateScroll = () => {
    scroll.onScroll()
    updateVisibleInputs()
  }
  useLayoutEffect(() => {
    updateVisibleInputs()
  })

  return (
    <ConversationScrollContext.Provider value={scroll}>
      <div className="relative flex min-h-0 flex-1">
        <ScrollArea
          className="min-h-0 flex-1"
          viewportRef={scroll.viewportRef}
          onScroll={updateScroll}
        >
          <div
            ref={scroll.contentRef}
            className="conversation-content mx-auto flex w-full flex-col gap-8 py-8"
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
                    finalAnswerId={finalAnswers.get(block.turnId)}
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
                finalAnswerId={undefined}
                retry={view.activeRetry}
              />
            ) : null}
          </div>
        </ScrollArea>
        <ConversationNavigation
          entries={view.entries}
          visibleInputs={visibleInputs}
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
      </div>
      {children}
    </ConversationScrollContext.Provider>
  )
}

function TurnBlock({
  entries,
  active,
  timing,
  finalAnswerId,
  retry,
}: Readonly<{
  entries: readonly ExecutionEntry[]
  active: boolean
  timing: TurnTiming | undefined
  finalAnswerId: string | undefined
  retry: ActiveModelRetry | undefined
}>) {
  const [expandedOverride, setExpanded] = useState<boolean>()
  const contentId = useId()
  const finalAnswer = entries.find(
    (entry): entry is Extract<ExecutionEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && entry.itemId === finalAnswerId,
  )
  const persistent = entries.filter(
    (entry) =>
      entry === finalAnswer ||
      entry.kind === "turn_terminal" ||
      (entry.kind === "permission" && entry.state !== "resolved"),
  )
  const activity = entries.filter((entry) => !persistent.includes(entry))
  const expanded = expandedOverride ?? finalAnswerId === undefined
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
      {activity.length > 0 || active ? (
        <div>
          <div
            className={cn(
              "flex items-center gap-1.5 text-left text-[14px] text-muted-foreground",
              finalAnswer ? "border-b pb-3" : "pb-1",
            )}
          >
            {activity.length > 0 ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={contentId}
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 text-left hover:text-foreground"
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
          <div
            id={contentId}
            className="conversation-disclosure"
            data-expanded={expanded}
            aria-hidden={!expanded}
            inert={!expanded}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex flex-col gap-4 pt-4">
                {activity.map((entry) => (
                  <EntryCell key={entryKey(entry)} entry={entry} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {persistent.map((entry) => (
        <EntryCell key={entryKey(entry)} entry={entry} />
      ))}
      {finalAnswer ? (
        <ResponseActions
          text={finalAnswer.text}
          at={timing?.completedAt ?? finalAnswer.at}
        />
      ) : null}
    </section>
  )
}

function EntryCell({ entry }: Readonly<{ entry: ExecutionEntry }>) {
  const workspaceRoot = useAppStore((state) => state.execution.workingDirectory)
  const selectSession = useAppStore((state) => state.selectSession)
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
          onOpenSession={selectSession}
        />
      )
    case "permission":
      return <PermissionCell entry={entry} />
    case "turn_terminal":
      return <TurnTerminalCell entry={entry} />
    case "context_compacted":
      return <CompactionCell entry={entry} />
    case "user_input":
      return <UserMessageCell entry={entry} queued={false} />
  }
}
