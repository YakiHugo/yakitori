import { ArrowDown, ArrowLeft, ChevronRight } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { ApiSessionDetail } from "../../server/protocol.ts"
import { imageAttachmentUrl } from "../composer-attachments.ts"
import { contextSourceAttributes } from "../conversation-context.ts"
import {
  createExecutionViewState,
  type ExecutionEntry,
  type ExecutionViewAction,
  projectExecutionView,
  reduceExecutionView,
} from "../execution-view.ts"
import { usePinnedScroll } from "../hooks/use-pinned-scroll.ts"
import { type AppRpcClient, createAppRpcClient } from "../lib/rpc-client.ts"
import { ApprovalRequests } from "./approval-bar.tsx"
import { CompactionCell } from "./cells/compaction-cell.tsx"
import { PermissionCell } from "./cells/permission-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { ToolCell } from "./cells/tool-cell.tsx"
import { TurnTerminalCell } from "./cells/turn-terminal-cell.tsx"
import { MarkdownView } from "./markdown.tsx"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import "./subagent-panel.css"

export type SubagentPanelProps = Readonly<{
  sessionId: string
  apiBase: string
  active: boolean
  onBack(): void
  onOpenAgent(sessionId: string): void
}>

export function SubagentPanel(props: SubagentPanelProps) {
  // Reset the complete local lifetime even when a caller changes the child
  // without keying the workspace panel.
  return <ChildTrace key={`${props.apiBase}:${props.sessionId}`} {...props} />
}

function ChildTrace({
  sessionId,
  apiBase,
  active,
  onBack,
  onOpenAgent,
}: SubagentPanelProps) {
  const [execution, setExecution] = useState(createExecutionViewState)
  const [session, setSession] = useState<ApiSessionDetail>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [permissionError, setPermissionError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const clientRef = useRef<AppRpcClient | undefined>(undefined)
  const executionRef = useRef(execution)
  const scroll = usePinnedScroll(sessionId)
  const view = useMemo(() => projectExecutionView(execution), [execution])
  const dispatch = useCallback((action: ExecutionViewAction) => {
    executionRef.current = reduceExecutionView(executionRef.current, action)
    setExecution(executionRef.current)
  }, [])

  useEffect(() => {
    // Retrying a terminal subscription error opens a fresh connection.
    void attempt
    // RPC clients support concurrent sessions, but one observer per session.
    // A private connection keeps this trace independent of the main selection.
    const client = createAppRpcClient({ apiBase })
    clientRef.current = client
    let disposed = false
    let replaySnapshot: ApiSessionDetail | undefined
    setLoading(true)
    setError(undefined)
    const stream = client.openSessionStream(
      sessionId,
      executionRef.current.lastSeq,
      {
        onSnapshot: ({ session: snapshot }) => {
          if (disposed) return
          replaySnapshot = snapshot
          setLoading(true)
          setSession(snapshot)
          dispatch({ type: "snapshot", session: snapshot })
        },
        onEvent: (event) => {
          if (disposed || event.sessionId !== sessionId) return
          dispatch({ type: "durable", event })
        },
        onTransient: (event) => {
          if (disposed || event.sessionId !== sessionId) return
          dispatch({ type: "transient", event })
        },
        onReplayComplete: () => {
          if (disposed) return
          if (replaySnapshot)
            dispatch({ type: "replay_completed", session: replaySnapshot })
          replaySnapshot = undefined
          setLoading(false)
        },
        onError: (cause) => {
          if (disposed) return
          dispatch({ type: "stream_unavailable" })
          setLoading(false)
          setError(cause instanceof Error ? cause.message : String(cause))
        },
      },
    )
    return () => {
      disposed = true
      clientRef.current = undefined
      stream.close()
      client.close()
    }
  }, [apiBase, sessionId, attempt, dispatch])

  useLayoutEffect(() => {
    if (active) scroll.onLayoutChange()
  }, [active, scroll.onLayoutChange])

  const pending = view.entries.filter(
    (entry): entry is Extract<ExecutionEntry, { kind: "permission" }> =>
      entry.kind === "permission" && entry.state !== "resolved",
  )
  const reversedEntries = [...view.entries].reverse()
  const latestTurn = reversedEntries.find((entry) => "turnId" in entry)
  const latestTerminal =
    latestTurn && "turnId" in latestTurn
      ? reversedEntries.find(
          (entry) =>
            entry.kind === "turn_terminal" &&
            entry.turnId === latestTurn.turnId,
        )
      : undefined
  const status = error
    ? "Unavailable"
    : loading
      ? "Loading trace"
      : pending.length > 0
        ? "Awaiting approval"
        : view.activeTurnId
          ? view.activeRetry
            ? "Retrying"
            : "Working"
          : latestTerminal?.kind === "turn_terminal"
            ? latestTerminal.state === "failed"
              ? "Failed"
              : latestTerminal.state === "cancelled"
                ? "Cancelled"
                : "Interrupted"
            : Object.values(view.turnTimings).some((turn) => turn.completedAt)
              ? "Completed"
              : "Idle"
  const blocks = useMemo(() => {
    const result: {
      key: string
      activity: boolean
      entries: ExecutionEntry[]
    }[] = []
    for (const [index, entry] of view.entries.entries()) {
      const activity =
        entry.kind === "tool" ||
        entry.kind === "reasoning" ||
        entry.kind === "context_compacted" ||
        (entry.kind === "permission" && entry.state === "resolved")
      const previous = result.at(-1)
      if (activity && previous?.activity) previous.entries.push(entry)
      else result.push({ key: String(index), activity, entries: [entry] })
    }
    return result
  }, [view.entries])
  const renderEntry = (entry: ExecutionEntry, index: number) => (
    <TraceEntry
      key={index}
      entry={entry}
      sessionId={sessionId}
      apiBase={apiBase}
      workspaceRoot={view.workingDirectory}
      onOpenAgent={onOpenAgent}
    />
  )

  return (
    <section className="subagent-panel" aria-label="Child agent execution">
      <header className="subagent-panel-header">
        <button
          type="button"
          onClick={onBack}
          className="subagent-back"
          aria-label="Back to agents"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="subagent-heading">
          <span className="subagent-eyebrow">Child agent</span>
          <h2 title={session?.title ?? sessionId}>
            {session?.title ?? sessionId}
          </h2>
        </div>
        <span className="subagent-status" role="status">
          <span data-running={Boolean(view.activeTurnId)} />
          {status}
        </span>
      </header>
      <div className="subagent-trace-surface">
        <ScrollArea
          className="min-h-0 min-w-0 flex-1"
          viewportRef={scroll.viewportRef}
          onScroll={scroll.onScroll}
        >
          <div ref={scroll.contentRef} className="subagent-trace">
            {view.entries.length === 0 ? (
              <p className="subagent-empty">
                {loading ? "Loading child execution…" : "No execution yet."}
              </p>
            ) : (
              blocks.map((block) =>
                block.activity ? (
                  <Collapsible key={block.key} className="subagent-activity">
                    <CollapsibleTrigger className="subagent-activity-trigger">
                      <ChevronRight size={14} />
                      Activity
                      <span>{block.entries.length}</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="subagent-activity-content">
                      {block.entries.map(renderEntry)}
                    </CollapsibleContent>
                  </Collapsible>
                ) : (
                  <div key={block.key}>{block.entries.map(renderEntry)}</div>
                ),
              )
            )}
            {view.activeRetry ? (
              <p role="status" className="subagent-notice">
                Retrying · attempt {view.activeRetry.nextAttempt} of{" "}
                {view.activeRetry.maxAttempts}. {view.activeRetry.message}
              </p>
            ) : null}
          </div>
        </ScrollArea>
        {!scroll.atBottom ? (
          <button
            type="button"
            className="subagent-jump"
            aria-label="Jump to latest child output"
            onClick={scroll.jumpToBottom}
          >
            <ArrowDown size={15} />
            Latest
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="subagent-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : null}
      {permissionError ? (
        <p className="subagent-error" role="alert">
          {permissionError}
        </p>
      ) : null}
      <ApprovalRequests
        pending={pending}
        isResolving={(id) =>
          pending.some(
            (entry) =>
              entry.permissionRequestId === id && entry.state === "resolving",
          )
        }
        onResolve={(_turnId, permissionRequestId, behavior) => {
          const client = clientRef.current
          if (!client) return
          dispatch({
            type: "permission_resolving",
            permissionRequestId,
            behavior,
          })
          setPermissionError(undefined)
          try {
            client.answerPermission(permissionRequestId, {
              behavior,
              reason: {
                kind: behavior === "allow" ? "user_allowed" : "user_denied",
              },
            })
          } catch (cause) {
            dispatch({
              type: "permission_retry",
              permissionRequestId,
              behavior,
            })
            setPermissionError(
              cause instanceof Error ? cause.message : String(cause),
            )
          }
        }}
      />
    </section>
  )
}

function TraceEntry({
  entry,
  sessionId,
  apiBase,
  workspaceRoot,
  onOpenAgent,
}: Readonly<{
  entry: ExecutionEntry
  sessionId: string
  apiBase: string
  workspaceRoot: string | undefined
  onOpenAgent(sessionId: string): void
}>) {
  switch (entry.kind) {
    case "user_input":
      return (
        <article className="subagent-task">
          <h3>Task</h3>
          <p>{entry.text}</p>
          {entry.contextAttachments?.map((excerpt) => (
            <blockquote key={excerpt.id}>
              <cite>{excerpt.source.label}</cite>
              <p>{excerpt.text}</p>
              {excerpt.kind === "annotation" && excerpt.comment ? (
                <p>{excerpt.comment}</p>
              ) : null}
            </blockquote>
          ))}
          {entry.attachments?.map((attachment) => (
            <a
              key={`${attachment.file.rolloutId}:${attachment.file.path}`}
              href={imageAttachmentUrl(attachment, apiBase)}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={imageAttachmentUrl(attachment, apiBase)}
                alt={attachment.name}
                loading="lazy"
              />
            </a>
          ))}
        </article>
      )
    case "assistant":
      return (
        <div
          {...contextSourceAttributes({
            kind: "message",
            label: "Child agent answer",
            sessionId,
            messageId: entry.itemId,
          })}
        >
          <MarkdownView
            text={entry.text}
            workspaceRoot={workspaceRoot}
            className="markdown text-sm leading-7"
          />
        </div>
      )
    case "reasoning":
      return <ReasoningCell entry={entry} workspaceRoot={workspaceRoot} />
    case "tool":
      return (
        <ToolCell
          entry={entry}
          apiBase={apiBase}
          workspaceRoot={workspaceRoot}
          onOpenSession={async (id) => onOpenAgent(id)}
        />
      )
    case "permission":
      return <PermissionCell entry={entry} />
    case "turn_terminal":
      return <TurnTerminalCell entry={entry} />
    case "context_compacted":
      return <CompactionCell entry={entry} />
  }
}
