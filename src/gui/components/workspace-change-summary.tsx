import { ArrowRight } from "lucide-react"
import type {
  GitStatusResponse,
  WorkspaceGitEntry,
  WorkspaceGitStats,
} from "../../protocol/workspace.ts"
import "./workspace-change-summary.css"

export function ChangeStats({
  stats,
}: Readonly<{
  stats?: WorkspaceGitStats | undefined
}>) {
  if (!stats) return null
  return (
    <span className="workspace-change-stats">
      {stats.binary ? (
        <span className="workspace-change-binary">Binary</span>
      ) : null}
      {!stats.binary || stats.additions > 0 || stats.deletions > 0 ? (
        <>
          <span className="workspace-change-additions">+{stats.additions}</span>
          <span className="workspace-change-deletions">−{stats.deletions}</span>
        </>
      ) : null}
    </span>
  )
}

export function ChangeFileLabel({
  entry,
  staged,
}: Readonly<{ entry: WorkspaceGitEntry; staged?: boolean }>) {
  const slash = entry.path.lastIndexOf("/")
  const filename = entry.path.slice(slash + 1)
  const directory = slash < 0 ? undefined : entry.path.slice(0, slash)
  const code =
    staged === true
      ? entry.indexStatus
      : staged === false
        ? entry.worktreeStatus
        : ![" ", ""].includes(entry.worktreeStatus)
          ? entry.worktreeStatus
          : entry.indexStatus
  const label =
    (
      {
        "?": "Untracked",
        A: "Added",
        M: "Modified",
        D: "Deleted",
        R: "Renamed",
        C: "Copied",
        U: "Unmerged",
        T: "Type changed",
      } as Record<string, string>
    )[code] ?? "Changed"
  return (
    <span className="workspace-change-file-label">
      <span className="workspace-change-filename">{filename}</span>
      {directory ? (
        <span className="workspace-change-directory">{directory}</span>
      ) : null}
      <span className="workspace-change-status">
        {label}
        {entry.originalPath ? (
          <>
            {" "}
            · {entry.originalPath} → {entry.path}
          </>
        ) : null}
      </span>
    </span>
  )
}

export function WorkspaceChangeSummary({
  status,
  onReview,
}: Readonly<{
  status: GitStatusResponse
  onReview(path?: string, staged?: boolean): void
}>) {
  if (!status.repository)
    return (
      <p className="workspace-change-summary-empty">
        This workspace is not a Git repository.
      </p>
    )
  const files = status.entries.map((entry) => ({
    entry,
    stats:
      entry.stagedStats || entry.unstagedStats
        ? {
            additions:
              (entry.stagedStats?.additions ?? 0) +
              (entry.unstagedStats?.additions ?? 0),
            deletions:
              (entry.stagedStats?.deletions ?? 0) +
              (entry.unstagedStats?.deletions ?? 0),
            binary: Boolean(
              entry.stagedStats?.binary || entry.unstagedStats?.binary,
            ),
          }
        : undefined,
  }))
  const totals = files.reduce<WorkspaceGitStats | undefined>(
    (total, { stats }) =>
      stats
        ? {
            additions: (total?.additions ?? 0) + stats.additions,
            deletions: (total?.deletions ?? 0) + stats.deletions,
            binary: Boolean(total?.binary || stats.binary),
          }
        : total,
    undefined,
  )
  return (
    <div className="workspace-change-summary">
      {files.length > 0 ? (
        <div className="workspace-change-summary-totals">
          <span>
            {files.length} changed {files.length === 1 ? "file" : "files"}
          </span>
          <span title="Staged + unstaged line changes">
            <ChangeStats stats={totals} />
          </span>
        </div>
      ) : null}
      {status.entries.length === 0 ? (
        <p className="workspace-change-summary-empty">Working tree clean</p>
      ) : (
        <ul className="workspace-change-summary-files">
          {files.slice(0, 5).map(({ entry, stats }) => {
            const staged = [" ", ""].includes(entry.worktreeStatus)
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  className="workspace-change-summary-file"
                  title={
                    entry.originalPath
                      ? `${entry.originalPath} → ${entry.path}`
                      : entry.path
                  }
                  onClick={() => onReview(entry.path, staged)}
                >
                  <ChangeFileLabel entry={entry} />
                  <span
                    title={
                      entry.stagedStats && entry.unstagedStats
                        ? "Staged + unstaged line changes"
                        : undefined
                    }
                  >
                    {entry.stagedStats && entry.unstagedStats ? (
                      <span className="sr-only">
                        Staged and unstaged totals:{" "}
                      </span>
                    ) : null}
                    <ChangeStats stats={stats} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <button
        type="button"
        className="workspace-change-summary-review"
        onClick={() => onReview()}
      >
        <span>
          {status.entries.length > 0
            ? `Review all ${status.entries.length} ${status.entries.length === 1 ? "file" : "files"}`
            : "View changes"}
        </span>
        <ArrowRight size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
