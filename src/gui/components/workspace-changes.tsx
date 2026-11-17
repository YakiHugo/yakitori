import {
  Check,
  Files,
  GitBranch,
  RefreshCw,
  Search,
  SquareArrowOutUpRight,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { GitDiffResponse } from "../../protocol/workspace.ts"
import { useWorkspaceGitStatus } from "../hooks/use-workspace-git-status.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import {
  useWorkspaceStore,
  type WorkspaceTab,
} from "../store/workspace-store.ts"
import { DiffView } from "./cells/diff-view.tsx"
import { type ChangeFileItem, ChangeFileTree } from "./change-file-tree.tsx"
import { Select } from "./ui/select.tsx"
import { ChangeStats } from "./workspace-change-summary.tsx"
import "./workspace-changes.css"

type ChangeTarget = Extract<WorkspaceTab, { kind: "changes" }>["target"]
type ChangesProps = Readonly<{
  cwd: string
  apiBase: string
  active?: boolean
  target?: ChangeTarget
}>

export function WorkspaceChanges(props: ChangesProps) {
  return <ChangesBrowser key={`${props.apiBase}:${props.cwd}`} {...props} />
}

function ChangesBrowser({ cwd, apiBase, active = true, target }: ChangesProps) {
  const { status, loading, error, refresh, revision } = useWorkspaceGitStatus({
    cwd,
    apiBase,
    active,
  })
  const [scope, setScope] = useState<"all" | "unstaged" | "staged">("all")
  const [query, setQuery] = useState("")
  const [selectedKey, setSelectedKey] = useState<string>()
  const [showFiles, setShowFiles] = useState(true)
  useEffect(() => {
    if (!target) return
    setScope("all")
    setQuery("")
    setSelectedKey(
      target.path === undefined
        ? undefined
        : `${target.staged ? "staged" : "unstaged"}:${target.path}`,
    )
  }, [target])

  const entries = status?.entries ?? []
  const unstaged: ChangeFileItem[] = entries
    .filter((entry) => ![" ", ""].includes(entry.worktreeStatus))
    .map((entry) => ({ entry, staged: false }))
  const staged: ChangeFileItem[] = entries
    .filter((entry) => ![" ", "?", ""].includes(entry.indexStatus))
    .map((entry) => ({ entry, staged: true }))
  const scoped =
    scope === "all"
      ? [...unstaged, ...staged]
      : scope === "staged"
        ? staged
        : unstaged
  const items = scoped.filter(({ entry }) =>
    `${entry.path} ${entry.originalPath ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const selected =
    items.find(
      (item) =>
        `${item.staged ? "staged" : "unstaged"}:${item.entry.path}` ===
        selectedKey,
    ) ??
    items.find(
      (item) =>
        item.entry.path === selectedKey?.slice(selectedKey.indexOf(":") + 1),
    ) ??
    items[0]
  const effectiveKey = selected
    ? `${selected.staged ? "staged" : "unstaged"}:${selected.entry.path}`
    : undefined
  const stats = scoped.flatMap(({ entry, staged: inIndex }) => {
    const value = inIndex ? entry.stagedStats : entry.unstagedStats
    return value ? [value] : []
  })
  const totals =
    stats.length > 0
      ? stats.reduce(
          (total, value) => ({
            additions: total.additions + value.additions,
            deletions: total.deletions + value.deletions,
            binary: false,
          }),
          { additions: 0, deletions: 0, binary: false },
        )
      : undefined
  const count = new Set(scoped.map(({ entry }) => entry.path)).size

  return (
    <div className="workspace-changes">
      <header className="changes-heading">
        <h2 className="sr-only">Review changes</h2>
        <div className="changes-repository-row">
          <div className="changes-branch" title={status?.root ?? cwd}>
            <GitBranch size={14} />
            <span>
              {status?.branch ??
                (status?.repository ? "Detached HEAD" : "Working tree")}
            </span>
          </div>
          <button
            type="button"
            className="changes-icon-button"
            aria-label="Refresh changes"
            title="Refresh changes"
            onClick={refresh}
          >
            <RefreshCw
              size={14}
              className={loading ? "animate-spin" : undefined}
            />
          </button>
        </div>
        <div className="changes-scope-row">
          <span className="changes-count">
            {count} changed {count === 1 ? "file" : "files"}
          </span>
          <span
            title={
              scope === "all"
                ? "Staged + unstaged line changes"
                : `${scope} line changes`
            }
          >
            <ChangeStats stats={totals} />
          </span>
          <Select<typeof scope>
            aria-label="Change scope"
            className="changes-scope-select"
            size="sm"
            variant="ghost"
            value={scope}
            onValueChange={setScope}
            options={[
              { value: "all", label: "All changes" },
              { value: "unstaged", label: "Unstaged" },
              { value: "staged", label: "Staged" },
            ]}
          />
          <button
            type="button"
            className="changes-icon-button"
            aria-label={showFiles ? "Hide changed files" : "Show changed files"}
            aria-pressed={showFiles}
            title={showFiles ? "Hide changed files" : "Show changed files"}
            onClick={() => {
              setShowFiles((value) => !value)
              setQuery("")
            }}
          >
            <Files size={14} />
          </button>
        </div>
      </header>
      {error ? (
        <div className="changes-message" role="alert">
          <p>{error}</p>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}
      {loading && !status ? (
        <p className="changes-message" role="status">
          Loading changes…
        </p>
      ) : null}
      {status?.repository === false ? (
        <p className="changes-message">
          This workspace is not a Git repository.
        </p>
      ) : status?.repository && entries.length === 0 ? (
        <div className="changes-empty">
          <Check size={24} strokeWidth={1.5} />
          <strong>Working tree clean</strong>
          <p>Saved file changes will appear here.</p>
        </div>
      ) : status?.repository ? (
        <div className="changes-layout" data-files={showFiles}>
          {showFiles ? (
            <aside className="changes-navigator" aria-label="File navigation">
              <label className="changes-search">
                <Search size={13} />
                <input
                  aria-label="Filter changed files"
                  placeholder="Filter files…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="changes-file-list">
                <ChangeFileTree
                  items={items}
                  selectedKey={effectiveKey}
                  onSelect={(item) =>
                    setSelectedKey(
                      `${item.staged ? "staged" : "unstaged"}:${item.entry.path}`,
                    )
                  }
                />
                {items.length === 0 ? (
                  <p className="changes-message">
                    {query ? "No matching files" : `No ${scope} changes`}
                  </p>
                ) : null}
              </div>
            </aside>
          ) : null}
          <section
            className="changes-reader"
            aria-label="Selected file changes"
          >
            {selected ? (
              <SelectedChange
                key={effectiveKey}
                item={selected}
                cwd={cwd}
                apiBase={apiBase}
                revision={revision}
                active={active}
                onStageChanged={() =>
                  setSelectedKey(
                    `${selected.staged ? "unstaged" : "staged"}:${selected.entry.path}`,
                  )
                }
              />
            ) : (
              <div className="changes-empty">
                <Search size={24} strokeWidth={1.5} />
                <strong>
                  {query ? "No matching files" : `No ${scope} changes`}
                </strong>
                <p>
                  {query
                    ? "Try a different filename or directory."
                    : "Choose another change scope to continue reviewing."}
                </p>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}

function SelectedChange({
  item: { entry, staged },
  cwd,
  apiBase,
  revision,
  active,
  onStageChanged,
}: Readonly<{
  item: ChangeFileItem
  cwd: string
  apiBase: string
  revision: number
  active: boolean
  onStageChanged(): void
}>) {
  const [diff, setDiff] = useState<GitDiffResponse>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)
  const code = staged ? entry.indexStatus : entry.worktreeStatus
  const stats = staged ? entry.stagedStats : entry.unstagedStats
  const action = staged ? "Unstage" : "Stage"
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new status snapshot invalidates the selected diff.
  useEffect(() => {
    if (!active) return
    let current = true
    setDiff(undefined)
    setError(undefined)
    void getAppRpcClient(apiBase)
      .request("git/diff", { cwd, path: entry.path, staged })
      .then(
        (result) => {
          if (current) setDiff(result)
        },
        (cause: unknown) => {
          if (current)
            setError(
              cause instanceof Error ? cause.message : "Could not load diff.",
            )
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, cwd, entry.path, staged, revision, active])
  const changeStage = async () => {
    if (pending) return
    setPending(true)
    setError(undefined)
    try {
      await getAppRpcClient(apiBase).request(
        staged ? "git/unstage" : "git/stage",
        { cwd, path: entry.path },
      )
      if (mounted.current) onStageChanged()
      window.dispatchEvent(new Event("yakitori:workspace-git-changed"))
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Could not update staging.",
        )
    } finally {
      if (mounted.current) setPending(false)
    }
  }
  return (
    <section
      className="changes-selected-file"
      aria-label={`${staged ? "Staged" : "Unstaged"} changes in ${entry.path}`}
    >
      <header className="changes-file-heading">
        <div
          className="changes-selected-path"
          title={
            entry.originalPath
              ? `${entry.originalPath} → ${entry.path}`
              : entry.path
          }
        >
          <span>{entry.path}</span>
          <small>
            {staged ? "Staged" : code === "?" ? "Untracked" : "Unstaged"}
            {entry.originalPath
              ? ` · ${entry.originalPath} → ${entry.path}`
              : ""}
          </small>
        </div>
        <ChangeStats stats={stats} />
        {code !== "D" ? (
          <button
            type="button"
            className="changes-icon-button changes-open-file"
            aria-label={`Open ${entry.path}`}
            title="Open file"
            onClick={() =>
              useWorkspaceStore.getState().openFile(entry.path, cwd)
            }
          >
            <SquareArrowOutUpRight size={13} />
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          className="changes-stage-action"
          aria-label={`${action} ${entry.path}`}
          onClick={() => void changeStage()}
        >
          {action}
        </button>
      </header>
      {error ? (
        <div role="alert" className="changes-message">
          {error}
        </div>
      ) : null}
      <div className="workspace-change-diff">
        {diff ? (
          stats?.binary ? (
            <p className="changes-message">
              Binary file {code === "D" ? "deleted" : "changed"}. A text diff is
              unavailable.
            </p>
          ) : stats &&
            stats.additions === 0 &&
            stats.deletions === 0 &&
            !diff.truncated ? (
            <p className="changes-message">
              {entry.originalPath
                ? "Renamed without line changes."
                : "File metadata changed. No line changes."}
            </p>
          ) : diff.text ? (
            <DiffView diff={diff} path={entry.path} embedded />
          ) : (
            <p className="changes-message">
              No line changes. This file may have been renamed or its
              permissions changed.
            </p>
          )
        ) : !error ? (
          <p role="status" className="changes-message">
            Loading diff…
          </p>
        ) : null}
      </div>
    </section>
  )
}
