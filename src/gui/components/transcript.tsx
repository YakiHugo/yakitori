import { ArrowDown, ChevronRight } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import type { ExecutionEntry, TurnTiming } from "../execution-view.ts"
import { usePinnedScroll } from "../hooks/use-pinned-scroll.ts"
import { formatElapsed } from "../lib/format.ts"
import { useAppStore, useExecutionView } from "../store/app-store.ts"
import { AssistantMessageCell } from "./cells/assistant-message-cell.tsx"
import { CompactionCell } from "./cells/compaction-cell.tsx"
import { PermissionCell } from "./cells/permission-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { ToolCell } from "./cells/tool-cell.tsx"
import { TurnTerminalCell } from "./cells/turn-terminal-cell.tsx"
import { UserMessageCell } from "./cells/user-message-cell.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

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

export function Transcript() {
  const view = useExecutionView()
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const scroll = usePinnedScroll(sessionId)
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [activeInput, setActiveInput] = useState<string>()
  const blocks = useMemo(() => groupEntries(view.entries), [view.entries])
  const inputs = view.entries.filter((entry) => entry.kind === "user_input")
  const queued = new Set(view.queuedInputIds)
  const updateScroll = () => {
    scroll.onScroll()
    const top = scroll.viewportRef.current?.getBoundingClientRect().top ?? 0
    let active = inputs[0]?.inputId
    for (const input of inputs) {
      const node = anchors.current.get(input.inputId)
      if (node && node.getBoundingClientRect().top <= top + 100)
        active = input.inputId
    }
    setActiveInput(active)
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <ScrollArea
        className="min-h-0 flex-1"
        viewportRef={scroll.viewportRef}
        onScroll={updateScroll}
      >
        <div
          ref={scroll.contentRef}
          className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-8"
        >
          {view.entries.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Conversation will appear here
            </p>
          ) : (
            blocks.map((block) => {
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
                />
              ) : (
                block.entries.map((entry) => (
                  <EntryCell key={entryKey(entry)} entry={entry} />
                ))
              )
            })
          )}
        </div>
      </ScrollArea>
      {inputs.length > 1 ? (
        <nav
          aria-label="Conversation messages"
          className="absolute top-1/2 left-1 z-10 flex max-h-[60%] -translate-y-1/2 flex-col gap-0.5"
        >
          {inputs.map((input, index) => (
            <button
              key={input.inputId}
              type="button"
              aria-label={`Jump to message ${index + 1}: ${input.text.slice(0, 80)}`}
              aria-current={
                (activeInput ?? inputs.at(-1)?.inputId) === input.inputId
                  ? "location"
                  : undefined
              }
              className="group relative flex h-3 min-h-0 w-6 shrink items-center outline-none"
              onClick={() => {
                const viewport = scroll.viewportRef.current
                const node = anchors.current.get(input.inputId)
                if (!viewport || !node) return
                scroll.pauseFollowing()
                viewport.scrollTop +=
                  node.getBoundingClientRect().top -
                  viewport.getBoundingClientRect().top -
                  24
                setActiveInput(input.inputId)
                scroll.onScroll()
              }}
            >
              <span className="h-0.5 w-2.5 rounded-full bg-muted-foreground/30 transition-all group-hover:w-5 group-hover:bg-foreground group-focus-visible:w-5 group-aria-current:w-5 group-aria-current:bg-foreground" />
              <span className="pointer-events-none absolute left-8 hidden w-72 rounded-xl border bg-popover p-3 text-left text-xs shadow-lg group-hover:block group-focus-visible:block">
                <span className="mb-1 block text-muted-foreground">
                  Message {index + 1}
                </span>
                <span className="line-clamp-3">
                  {input.text || "Attached images"}
                </span>
              </span>
            </button>
          ))}
        </nav>
      ) : null}
      {!scroll.atBottom ? (
        <button
          type="button"
          aria-label="Jump to latest output"
          onClick={scroll.jumpToBottom}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border bg-background p-2 text-foreground shadow-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowDown className="size-5" />
        </button>
      ) : null}
    </div>
  )
}

function TurnBlock({
  entries,
  active,
  timing,
}: Readonly<{
  entries: readonly ExecutionEntry[]
  active: boolean
  timing: TurnTiming | undefined
}>) {
  const [expanded, setExpanded] = useState(false)
  const last = [...entries]
    .reverse()
    .find(
      (entry) => entry.kind !== "permission" && entry.kind !== "turn_terminal",
    )
  // Providers do not expose a common final-answer phase. The trailing assistant
  // item is the visible response; a message followed by tools remains activity.
  const visible = new Set(
    entries.filter(
      (entry) =>
        entry.kind === "turn_terminal" ||
        (entry.kind === "permission" && entry.state !== "resolved") ||
        (entry === last && (active || entry.kind === "assistant")),
    ),
  )
  const activity = entries.filter((entry) => !visible.has(entry))
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
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={active ? "Current response" : "Response"}
    >
      {activity.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center gap-1.5 border-b pb-3 text-left text-sm text-muted-foreground hover:text-foreground"
          >
            {active
              ? "Working"
              : seconds === undefined
                ? "Activity"
                : `Worked for ${formatElapsed(seconds)}`}
            <ChevronRight
              className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        </div>
      ) : null}
      {entries
        .filter((entry) => expanded || visible.has(entry))
        .map((entry) => (
          <EntryCell key={entryKey(entry)} entry={entry} />
        ))}
    </section>
  )
}

function EntryCell({ entry }: Readonly<{ entry: ExecutionEntry }>) {
  const workspaceRoot = useAppStore((state) => state.execution.workingDirectory)
  const selectSession = useAppStore((state) => state.selectSession)
  switch (entry.kind) {
    case "assistant":
      return <AssistantMessageCell entry={entry} />
    case "reasoning":
      return <ReasoningCell entry={entry} />
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
