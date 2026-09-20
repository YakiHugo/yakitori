import {
  ChevronDown,
  FileText,
  GitBranch,
  GitCompareArrows,
  Image,
  Monitor,
  Users,
} from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ImageAttachment } from "../../kernel/events.ts"
import type { ContextExcerpt } from "../../kernel/input-context.ts"
import type { GitStatusResponse } from "../../server/workspace.ts"
import { imageAttachmentUrl } from "../composer-attachments.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { useSessionAgents } from "../hooks/use-session-agents.ts"
import "./session-summary.css"

export function SessionSummary() {
  const sessionId = useAppStore((state) => state.selectedSession?.id)
  const cwd = useAppStore(
    (state) =>
      state.execution.workingDirectory ??
      state.selectedSession?.workingDirectory,
  )
  const apiBase = useAppStore((state) => state.apiBase)
  if (!sessionId) return null
  return (
    <SummaryPopover
      key={`${sessionId}:${apiBase}:${cwd}`}
      cwd={cwd}
      apiBase={apiBase}
    />
  )
}

function SummaryPopover({
  cwd,
  apiBase,
}: Readonly<{ cwd: string | undefined; apiBase: string }>) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number }>()
  const [status, setStatus] = useState<GitStatusResponse>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const activeTurnId = useAppStore((state) => state.execution.activeTurnId)
  const entries = useAppStore((state) => state.execution.entries)
  const open = anchor !== undefined
  const sessionId = useAppStore((state) => state.selectedSession?.id)
  const agents = useSessionAgents(apiBase, sessionId, open)
  const completedAgents = agents.agents.filter(
    (agent) => typeof agent.status === "object" && "completed" in agent.status,
  ).length
  const runningAgents = agents.agents.filter(
    (agent) => agent.status === "running" || agent.status === "pending_init",
  ).length
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(apiBase, window.location.href).hostname,
  )
  const sources = useMemo(() => {
    const images = new Map<string, ImageAttachment>()
    const excerpts = new Map<string, ContextExcerpt>()
    for (const entry of entries) {
      if (entry.kind !== "user_input") continue
      for (const attachment of entry.attachments ?? [])
        images.set(
          `${attachment.file.rolloutId}:${attachment.file.path}`,
          attachment,
        )
      for (const excerpt of entry.contextAttachments ?? [])
        excerpts.set(excerpt.id, excerpt)
    }
    return { images: [...images.values()], excerpts: [...excerpts.values()] }
  }, [entries])
  const sourceCount = sources.images.length + sources.excerpts.length

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (panel.current?.contains(target) || trigger.current?.contains(target))
    const dismissOutside = (event: Event) => {
      if (!inside(event.target)) setAnchor(undefined)
    }
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setAnchor(undefined)
      trigger.current?.focus()
    }
    const dismissResize = () => setAnchor(undefined)
    document.addEventListener("pointerdown", dismissOutside)
    document.addEventListener("focusin", dismissOutside)
    document.addEventListener("keydown", dismissEscape)
    window.addEventListener("resize", dismissResize)
    return () => {
      document.removeEventListener("pointerdown", dismissOutside)
      document.removeEventListener("focusin", dismissOutside)
      document.removeEventListener("keydown", dismissEscape)
      window.removeEventListener("resize", dismissResize)
    }
  }, [open])

  // A turn boundary and window focus invalidate the current working-tree snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and activeTurnId invalidate Git status.
  useEffect(() => {
    if (!open || !cwd) return
    let current = true
    setLoading(true)
    setStatus(undefined)
    setError(undefined)
    void getAppRpcClient(apiBase)
      .request("git/status", { cwd })
      .then(
        (result) => {
          if (!current) return
          setStatus(result)
          setLoading(false)
        },
        (cause: unknown) => {
          if (!current) return
          setError(
            cause instanceof Error ? cause.message : "Could not load changes.",
          )
          setLoading(false)
        },
      )
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener("focus", refresh)
    return () => {
      current = false
      window.removeEventListener("focus", refresh)
    }
  }, [apiBase, cwd, open, activeTurnId, revision])

  const staged = status?.entries.filter(
    (entry) => ![" ", "?", ""].includes(entry.indexStatus),
  ).length
  const unstaged = status?.entries.filter(
    (entry) => ![" ", "?", ""].includes(entry.worktreeStatus),
  ).length
  const untracked = status?.entries.filter(
    (entry) => entry.indexStatus === "?",
  ).length

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="session-summary-trigger"
        aria-label="Session context"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) return setAnchor(undefined)
          const rect = trigger.current?.getBoundingClientRect()
          if (rect)
            setAnchor({
              top: rect.bottom + 8,
              right: Math.min(
                Math.max(12, window.innerWidth - rect.right),
                Math.max(12, window.innerWidth - 372),
              ),
            })
        }}
      >
        <Monitor size={14} aria-hidden="true" />
        <span>Context</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {anchor
        ? createPortal(
            <div
              ref={panel}
              id={id}
              role="dialog"
              aria-label="Session context"
              tabIndex={-1}
              className="session-summary-popover"
              style={{
                top: anchor.top,
                right: anchor.right,
                maxHeight: `calc(100dvh - ${anchor.top + 12}px)`,
              }}
            >
              <section className="session-summary-section">
                <h3>Environment</h3>
                <div className="session-summary-environment">
                  <Monitor size={16} aria-hidden="true" />
                  <span>{local ? "Local" : "Server"}</span>
                  <span className="session-summary-environment-status">
                    {local ? "On this computer" : new URL(apiBase).host}
                  </span>
                </div>
                <p className="session-summary-path">
                  {cwd ?? "Working directory unavailable"}
                </p>
                <div className="session-summary-branch">
                  <GitBranch size={13} aria-hidden="true" />
                  <span>
                    {loading
                      ? "Loading branch…"
                      : status?.repository
                        ? (status.branch ?? "Branch unavailable")
                        : status
                          ? "Not a Git repository"
                          : "Branch unavailable"}
                  </span>
                </div>
              </section>
              <section className="session-summary-section">
                <h3>Changes</h3>
                {loading ? (
                  <p role="status" className="session-summary-empty">
                    Loading changes…
                  </p>
                ) : error ? (
                  <div className="session-summary-error">
                    <p role="alert">{error}</p>
                    <button
                      type="button"
                      onClick={() => setRevision((value) => value + 1)}
                    >
                      Retry
                    </button>
                  </div>
                ) : status?.repository ? (
                  <button
                    type="button"
                    className="session-summary-changes"
                    onClick={() => {
                      useWorkspaceStore.getState().addTab("changes")
                      setAnchor(undefined)
                      trigger.current?.focus()
                    }}
                  >
                    <GitCompareArrows size={15} aria-hidden="true" />
                    <span>
                      {status.entries.length === 0
                        ? "Working tree clean"
                        : `${status.entries.length} changed ${status.entries.length === 1 ? "file" : "files"}`}
                      {status.entries.length > 0 ? (
                        <small>
                          {staged} staged · {unstaged} unstaged · {untracked}{" "}
                          untracked
                        </small>
                      ) : null}
                    </span>
                    <span className="session-summary-view">View</span>
                  </button>
                ) : (
                  <p className="session-summary-empty">
                    {status
                      ? "No Git changes available."
                      : "Changes unavailable."}
                  </p>
                )}
              </section>
              <section className="session-summary-section">
                <h3>Subagents</h3>
                <button
                  type="button"
                  className="session-summary-changes"
                  onClick={() => {
                    if (sessionId)
                      useWorkspaceStore.getState().openAgents(sessionId)
                    setAnchor(undefined)
                    trigger.current?.focus()
                  }}
                >
                  <Users size={16} />
                  <span>
                    {agents.loading && agents.agents.length === 0
                      ? "Loading subagents…"
                      : agents.error
                        ? "View subagents"
                        : agents.agents.length === 0
                          ? "No subagents yet"
                          : `${agents.agents.length} ${agents.agents.length === 1 ? "subagent" : "subagents"}`}
                    {agents.agents.length > 0 && (
                      <small>
                        {runningAgents} working · {completedAgents} completed
                      </small>
                    )}
                  </span>
                  <span className="session-summary-view">View</span>
                </button>
              </section>
              <section className="session-summary-section">
                <h3>
                  Sources <span>{sourceCount}</span>
                </h3>
                {sourceCount === 0 ? (
                  <p className="session-summary-empty">
                    No attachments or excerpts in this session.
                  </p>
                ) : (
                  <div className="session-summary-sources">
                    {sources.excerpts.map((excerpt) => (
                      <details key={excerpt.id}>
                        <summary>
                          <FileText size={14} aria-hidden="true" />
                          <span>{excerpt.source.label}</span>
                          <ChevronDown size={12} aria-hidden="true" />
                        </summary>
                        {excerpt.source.path || excerpt.source.url ? (
                          <p className="session-summary-source-location">
                            {excerpt.source.path ?? excerpt.source.url}
                          </p>
                        ) : null}
                        <blockquote>{excerpt.text}</blockquote>
                        {excerpt.kind === "annotation" && excerpt.comment ? (
                          <p className="session-summary-annotation">
                            {excerpt.comment}
                          </p>
                        ) : null}
                      </details>
                    ))}
                    {sources.images.map((attachment) => (
                      <details
                        key={`${attachment.file.rolloutId}:${attachment.file.path}`}
                      >
                        <summary>
                          <Image size={14} aria-hidden="true" />
                          <span>{attachment.name}</span>
                          <ChevronDown size={12} aria-hidden="true" />
                        </summary>
                        <img
                          src={imageAttachmentUrl(attachment, apiBase)}
                          alt={attachment.name}
                          loading="lazy"
                        />
                      </details>
                    ))}
                  </div>
                )}
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
