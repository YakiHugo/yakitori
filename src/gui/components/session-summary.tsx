import { useTranslation } from "../i18n/use-translation.ts"
import {
  ChevronDown,
  FileText,
  GitBranch,
  GitPullRequest,
  Image,
  Monitor,
  Timer,
  Users,
} from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { UserAttachment } from "../../protocol/asset-types.ts"
import { assetSourceKey } from "../../protocol/asset-types.ts"
import type { ContextExcerpt } from "../../protocol/input-context.ts"
import type { SessionCacheExpiry } from "../../protocol/session-cache-expiry.ts"
import type { GitPullRequestsResponse } from "../../protocol/workspace.ts"
import { attachmentUrl } from "../composer-attachments.ts"
import { useSessionAgents } from "../hooks/use-session-agents.ts"
import { useWorkspaceGitStatus } from "../hooks/use-workspace-git-status.ts"
import { isUnmodifiedEscape } from "../lib/escape-key.ts"
import { openUrlTarget } from "../lib/open-resource.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { PdfAttachmentCard } from "./pdf-attachment.tsx"
import { TelemetryRail } from "./telemetry-rail.tsx"
import { WorkspaceChangeSummary } from "./workspace-change-summary.tsx"
import "./session-summary.css"

export function SessionSummary() {
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const cwd = useAppStore((state) =>
    state.selection.sessionId &&
    state.selectedSession?.id === state.selection.sessionId
      ? (state.execution.workingDirectory ??
        state.selectedSession.workingDirectory)
      : undefined,
  )
  const apiBase = useAppStore((state) => state.apiBase)
  const selectedSession = useAppStore((state) => state.selectedSession)
  if (!sessionId || selectedSession?.id !== sessionId) return null
  return (
    <SummaryPopover
      key={`${sessionId}:${apiBase}:${cwd}:${selectedSession.gitInfo?.branch}`}
      cwd={cwd}
      apiBase={apiBase}
      gitInfo={selectedSession.gitInfo}
      cacheExpiry={selectedSession.cacheExpiry}
    />
  )
}

function SummaryPopover({
  cwd,
  apiBase,
  gitInfo,
  cacheExpiry,
}: Readonly<{
  cwd: string | undefined
  apiBase: string
  gitInfo: import("../../protocol/session-metadata.ts").GitInfo | undefined
  cacheExpiry: SessionCacheExpiry | undefined
}>) {
  const { locale, t } = useTranslation()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number }>()
  const [pullRequests, setPullRequests] = useState<GitPullRequestsResponse>()
  const [pullRequestsLoading, setPullRequestsLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [latestCacheExpiry, setLatestCacheExpiry] = useState(cacheExpiry)
  const [cacheReadFailed, setCacheReadFailed] = useState(false)
  const completedTurns = useAppStore((state) => state.execution.telemetry.turns)
  const entries = useAppStore((state) => state.execution.entries)
  const open = anchor !== undefined
  const { status, loading, error, refresh, revision } = useWorkspaceGitStatus({
    cwd,
    apiBase,
    active: open,
  })
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
    const images = new Map<string, UserAttachment>()
    const excerpts = new Map<string, ContextExcerpt>()
    for (const entry of entries) {
      if (entry.kind !== "user_input") continue
      for (const attachment of entry.content.attachments)
        images.set(assetSourceKey(attachment.file), attachment)
      for (const excerpt of entry.contextAttachments ?? [])
        excerpts.set(excerpt.id, excerpt)
    }
    return { images: [...images.values()], excerpts: [...excerpts.values()] }
  }, [entries])
  const sourceCount = sources.images.length + sources.excerpts.length
  const expiresAt = latestCacheExpiry?.expiresAt
    ? Date.parse(latestCacheExpiry.expiresAt)
    : undefined
  const expired = expiresAt !== undefined && now >= expiresAt

  useEffect(() => setLatestCacheExpiry(cacheExpiry), [cacheExpiry])

  // The selected detail is projected from live events without the provider
  // selection recorded in the rollout. Refresh its server-owned cache summary
  // when a turn completes or the user opens Context after a completed turn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: completedTurns invalidates the server-owned cache projection.
  useEffect(() => {
    if (!open || !sessionId) return
    let current = true
    setCacheReadFailed(false)
    void getAppRpcClient(apiBase)
      .request("session/read", { sessionId })
      .then(
        (response) => {
          if (current && response.session?.id === sessionId)
            setLatestCacheExpiry(response.session.cacheExpiry)
        },
        () => {
          if (current) setCacheReadFailed(true)
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, completedTurns, open, sessionId])

  useEffect(() => {
    if (!open || expiresAt === undefined || expiresAt <= now) return
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(expiresAt - now + 100, 2_147_483_647),
    )
    return () => window.clearTimeout(timer)
  }, [open, expiresAt, now])

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
      if (!isUnmodifiedEscape(event)) return
      event.preventDefault()
      event.stopPropagation()
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

  const pullRequestBranch =
    gitInfo?.branch ?? (loading ? undefined : status?.branch)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshed Git snapshots invalidate pull-request status.
  useEffect(() => {
    if (!open || !cwd) return
    let current = true
    setPullRequests(undefined)
    setPullRequestsLoading(false)
    if (pullRequestBranch) {
      setPullRequestsLoading(true)
      void getAppRpcClient(apiBase)
        .request("git/pullRequests", { cwd, branch: pullRequestBranch })
        .then(
          (result) => {
            if (current) setPullRequests(result)
          },
          () => {
            if (current)
              setPullRequests({ available: false, reason: "unavailable" })
          },
        )
        .finally(() => {
          if (current) setPullRequestsLoading(false)
        })
    }
    return () => {
      current = false
    }
  }, [apiBase, cwd, open, pullRequestBranch, revision])

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
        aria-label={t("Session context")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) return setAnchor(undefined)
          setNow(Date.now())
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
      </button>
      {anchor
        ? createPortal(
            <div
              ref={panel}
              id={id}
              role="dialog"
              aria-label={t("Session context")}
              tabIndex={-1}
              className="session-summary-popover"
              style={{
                top: anchor.top,
                right: anchor.right,
                maxHeight: `calc(100dvh - ${anchor.top + 12}px)`,
              }}
            >
              <section className="session-summary-section">
                <TelemetryRail />
              </section>
              <section className="session-summary-section">
                <h3>{t("KV cache")}</h3>
                {cacheReadFailed ? (
                  <p className="session-summary-empty">
                    {t("Could not refresh cache status.")}
                  </p>
                ) : latestCacheExpiry ? (
                  <div className="session-summary-cache">
                    <Timer size={16} aria-hidden="true" />
                    <div>
                      <strong>
                        {expiresAt === undefined
                          ? t("Expiry unknown")
                          : latestCacheExpiry.status === "minimum"
                            ? expired
                              ? t("Retention uncertain")
                              : t("Within estimated retention window")
                            : expired
                              ? t("Likely expired")
                              : t("Possibly cached")}
                      </strong>
                      <span>
                        {t("Last turn:")} {latestCacheExpiry.provider} ·{" "}
                        {new Date(
                          latestCacheExpiry.lastTurnCompletedAt,
                        ).toLocaleString(locale)}
                      </span>
                      {latestCacheExpiry.lastRequestStartedAt ? (
                        <span>
                          {t("Last model request started:")}{" "}
                          {new Date(
                            latestCacheExpiry.lastRequestStartedAt,
                          ).toLocaleString(locale)}
                        </span>
                      ) : null}
                      <span>
                        {latestCacheExpiry.ttlDescription}
                        {expiresAt === undefined
                          ? ""
                          : ` · ${latestCacheExpiry.status === "minimum" ? "Estimated earliest expiry" : "Estimated expiry"} ${new Date(expiresAt).toLocaleString(locale)}`}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="session-summary-empty">
                    {t("No completed provider turn in this session yet.")}
                  </p>
                )}
              </section>
              <section className="session-summary-section">
                <h3>{t("Environment")}</h3>
                <div className="session-summary-environment">
                  <Monitor size={16} aria-hidden="true" />
                  <span>{local ? t("Local") : t("Server")}</span>
                  <span className="session-summary-environment-status">
                    {local ? t("On this computer") : new URL(apiBase).host}
                  </span>
                </div>
                <p className="session-summary-path">
                  {cwd ?? t("Working directory unavailable")}
                </p>
                <div className="session-summary-branch">
                  <GitBranch size={13} aria-hidden="true" />
                  <span>
                    {gitInfo?.branch ??
                      (status?.repository
                        ? (status.branch ?? t("Branch unavailable"))
                        : status
                          ? t("Not a Git repository")
                          : loading
                            ? t("Loading branch…")
                            : t("Branch unavailable"))}
                  </span>
                </div>
                {gitInfo?.branch &&
                status?.branch &&
                gitInfo.branch !== status.branch ? (
                  <p className="session-summary-workspace-branch">
                    {t("Workspace is currently on")} {status.branch}
                  </p>
                ) : null}
              </section>
              <section className="session-summary-section">
                <h3>
                  {t("Pull requests")}{" "}
                  {pullRequests?.available ? (
                    <span>{pullRequests.pullRequests.length}</span>
                  ) : null}
                </h3>
                {pullRequestsLoading ? (
                  <p role="status" className="session-summary-empty">
                    {t("Loading pull requests…")}
                  </p>
                ) : pullRequests?.available ? (
                  pullRequests.pullRequests.length === 0 ? (
                    <p className="session-summary-empty">
                      {t(
                        "No current or historical PRs for this session branch.",
                      )}
                    </p>
                  ) : (
                    <div className="session-summary-pull-requests">
                      {pullRequests.pullRequests.map((pullRequest) => (
                        <a
                          key={pullRequest.number}
                          href={pullRequest.url}
                          onClick={(event) => {
                            event.preventDefault()
                            void openUrlTarget({
                              kind: "url",
                              url: pullRequest.url,
                            })
                          }}
                        >
                          <GitPullRequest size={14} aria-hidden="true" />
                          <span>
                            <strong>
                              #{pullRequest.number} {pullRequest.title}
                            </strong>
                            <small>{formatPullRequestState(pullRequest)}</small>
                          </span>
                        </a>
                      ))}
                    </div>
                  )
                ) : (
                  <p className="session-summary-empty">
                    {t(
                      "PR status is unavailable. Install and sign in to GitHub CLI to load current and historical PRs.",
                    )}
                  </p>
                )}
              </section>
              <section className="session-summary-section">
                <h3>{t("Changes")}</h3>
                {loading && !status ? (
                  <p role="status" className="session-summary-empty">
                    {t("Loading changes…")}
                  </p>
                ) : error ? (
                  <div className="session-summary-error">
                    <p role="alert">{error}</p>
                    <button type="button" onClick={refresh}>
                      {t("Retry")}
                    </button>
                  </div>
                ) : status?.repository ? (
                  <>
                    {status.entries.length > 0 ? (
                      <p className="session-summary-change-scopes">
                        {staged} {t("staged ·")} {unstaged} {t("unstaged ·")}{" "}
                        {untracked} untracked
                      </p>
                    ) : null}
                    <WorkspaceChangeSummary
                      status={status}
                      onReview={(path, staged) => {
                        useWorkspaceStore.getState().openChanges(path, staged)
                        setAnchor(undefined)
                        trigger.current?.focus()
                      }}
                    />
                  </>
                ) : (
                  <p className="session-summary-empty">
                    {status
                      ? t("No Git changes available.")
                      : t("Changes unavailable.")}
                  </p>
                )}
              </section>
              <section className="session-summary-section">
                <h3>{t("Subagents")}</h3>
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
                      ? t("Loading subagents…")
                      : agents.error
                        ? t("View subagents")
                        : agents.agents.length === 0
                          ? t("No subagents yet")
                          : `${agents.agents.length} ${agents.agents.length === 1 ? "subagent" : "subagents"}`}
                    {agents.agents.length > 0 && (
                      <small>
                        {runningAgents} {t("working ·")} {completedAgents}{" "}
                        completed
                      </small>
                    )}
                  </span>
                  <span className="session-summary-view">{t("View")}</span>
                </button>
              </section>
              <section className="session-summary-section">
                <h3>
                  {t("Sources")} <span>{sourceCount}</span>
                </h3>
                {sourceCount === 0 ? (
                  <p className="session-summary-empty">
                    {t("No attachments or excerpts in this session.")}
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
                        {excerpt.source.kind !== "message" ? (
                          <p className="session-summary-source-location">
                            {excerpt.source.kind === "file"
                              ? excerpt.source.path
                              : excerpt.source.kind === "browser"
                                ? excerpt.source.url
                                : ""}
                          </p>
                        ) : null}
                        <blockquote>{excerpt.text}</blockquote>
                        {excerpt.comment ? (
                          <p className="session-summary-annotation">
                            {excerpt.comment}
                          </p>
                        ) : null}
                      </details>
                    ))}
                    {sources.images.map((attachment) => (
                      <details key={assetSourceKey(attachment.file)}>
                        <summary>
                          <Image size={14} aria-hidden="true" />
                          <span>{attachment.name}</span>
                          <ChevronDown size={12} aria-hidden="true" />
                        </summary>
                        {attachment.mediaType === "application/pdf" ? (
                          <PdfAttachmentCard
                            attachment={attachment}
                            apiBase={apiBase}
                          />
                        ) : (
                          <img
                            src={attachmentUrl(attachment, apiBase)}
                            alt={attachment.name}
                            loading="lazy"
                          />
                        )}
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

function formatPullRequestState(
  pullRequest: Extract<
    GitPullRequestsResponse,
    { available: true }
  >["pullRequests"][number],
): string {
  if (pullRequest.isDraft && pullRequest.state === "OPEN") return "Draft"
  return pullRequest.state[0] + pullRequest.state.slice(1).toLocaleLowerCase()
}
