import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  GitDiffResponse,
  GitStatusResponse,
} from "../../server/workspace.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { DiffView } from "./cells/diff-view.tsx"

const iconButton =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"

export function WorkspaceChanges(
  props: Readonly<{ cwd: string; apiBase: string }>,
) {
  return <ChangesBrowser key={`${props.apiBase}:${props.cwd}`} {...props} />
}

function ChangesBrowser({
  cwd,
  apiBase,
}: Readonly<{ cwd: string; apiBase: string }>) {
  const [status, setStatus] = useState<GitStatusResponse>()
  const [staged, setStaged] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const activeTurnId = useAppStore((state) => state.execution.activeTurnId)

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly invalidates Git status on refresh.
  useEffect(() => {
    let current = true
    setLoading(true)
    setError(undefined)
    void getAppRpcClient(apiBase)
      .request("git/status", { cwd })
      .then(
        (result) => {
          if (current) {
            setStatus(result)
            setLoading(false)
          }
        },
        (cause: unknown) => {
          if (current) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not load changes.",
            )
            setLoading(false)
          }
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, cwd, revision, activeTurnId])

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  const entries = status?.entries ?? []
  const stagedEntries = entries.filter(
    (entry) =>
      entry.indexStatus !== " " &&
      entry.indexStatus !== "?" &&
      entry.indexStatus !== "",
  )
  const unstagedEntries = entries.filter(
    (entry) => entry.worktreeStatus !== " " && entry.worktreeStatus !== "",
  )
  const visible = staged ? stagedEntries : unstagedEntries

  return (
    <div className="workspace-changes flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex min-h-11 items-center gap-2 border-b px-4">
        <GitBranch size={13} className="shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          title={status?.root}
        >
          {status?.branch ??
            (status?.repository ? "Detached HEAD" : "Working tree")}
        </span>
        <button
          type="button"
          className={iconButton}
          aria-label="Refresh changes"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw
            size={13}
            className={loading ? "animate-spin" : undefined}
          />
        </button>
      </div>
      <fieldset
        className="flex gap-1 border-b px-3 py-2"
        aria-label="Change scope"
      >
        <button
          type="button"
          aria-pressed={!staged}
          className={`rounded-md px-2.5 py-1.5 ${!staged ? "bg-foreground/7 text-foreground" : "text-muted-foreground hover:bg-foreground/5"}`}
          onClick={() => setStaged(false)}
        >
          Unstaged{" "}
          <span className="ml-1 text-muted-foreground">
            {unstagedEntries.length}
          </span>
        </button>
        <button
          type="button"
          aria-pressed={staged}
          className={`rounded-md px-2.5 py-1.5 ${staged ? "bg-foreground/7 text-foreground" : "text-muted-foreground hover:bg-foreground/5"}`}
          onClick={() => setStaged(true)}
        >
          Staged{" "}
          <span className="ml-1 text-muted-foreground">
            {stagedEntries.length}
          </span>
        </button>
      </fieldset>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {error ? (
          <p role="alert" className="px-4 py-3 text-destructive">
            {error}
          </p>
        ) : null}
        {loading && !status ? (
          <p role="status" className="px-4 py-4 text-muted-foreground">
            Loading changes…
          </p>
        ) : null}
        {status?.repository === false ? (
          <p className="px-4 py-6 text-muted-foreground">
            This workspace is not a Git repository.
          </p>
        ) : null}
        {status?.repository && visible.length === 0 ? (
          <div className="px-4 py-6 text-muted-foreground">
            <p className="text-foreground/80">
              {entries.length === 0
                ? "Working tree clean"
                : staged
                  ? "No staged changes"
                  : "No unstaged changes"}
            </p>
            <p className="mt-1 leading-5">
              {staged
                ? "Stage files to prepare your next commit."
                : "File changes will appear here."}
            </p>
          </div>
        ) : null}
        {visible.map((entry) => (
          <ChangeEntry
            key={`${staged}:${entry.path}`}
            entry={entry}
            staged={staged}
            cwd={cwd}
            apiBase={apiBase}
            revision={`${revision}:${activeTurnId ?? ""}`}
            onChanged={() => setRevision((value) => value + 1)}
          />
        ))}
      </div>
    </div>
  )
}

function ChangeEntry({
  entry,
  staged,
  cwd,
  apiBase,
  revision,
  onChanged,
}: Readonly<{
  entry: GitStatusResponse["entries"][number]
  staged: boolean
  cwd: string
  apiBase: string
  revision: string
  onChanged(): void
}>) {
  const [expanded, setExpanded] = useState(false)
  const [diff, setDiff] = useState<GitDiffResponse>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const active = useRef(true)
  const code = staged ? entry.indexStatus : entry.worktreeStatus
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
    )[code] ?? code

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshed status invalidates expanded diffs even when their paths are unchanged.
  useEffect(() => {
    if (!expanded) return
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
  }, [apiBase, cwd, entry.path, expanded, staged, revision])

  const changeStage = async () => {
    if (pending) return
    setPending(true)
    setError(undefined)
    try {
      await getAppRpcClient(apiBase).request(
        staged ? "git/unstage" : "git/stage",
        { cwd, path: entry.path },
      )
      if (active.current) onChanged()
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error ? cause.message : "Could not update staging.",
        )
    } finally {
      if (active.current) setPending(false)
    }
  }
  const action = staged ? "Unstage" : "Stage"

  return (
    <div className="workspace-change-entry">
      <div className="flex items-center gap-1 px-2 hover:bg-foreground/5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
          aria-expanded={expanded}
          aria-label={`${entry.path}, ${label}`}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={12}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span
            className="min-w-0 flex-1 truncate"
            title={
              entry.originalPath
                ? `${entry.originalPath} → ${entry.path}`
                : entry.path
            }
          >
            {entry.originalPath ? (
              <span className="text-muted-foreground">
                {entry.originalPath} →{" "}
              </span>
            ) : null}
            {entry.path}
          </span>
          <span
            className={`w-4 shrink-0 text-center font-mono text-[10px] ${code === "D" ? "text-red-600 dark:text-red-400" : code === "A" || code === "?" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
            title={label}
          >
            {code}
          </span>
        </button>
        <button
          type="button"
          disabled={pending}
          className={iconButton}
          aria-label={`${action} ${entry.path}`}
          title={`${action} file`}
          onClick={() => void changeStage()}
        >
          {staged ? <Minus size={13} /> : <Plus size={13} />}
        </button>
      </div>
      {error ? (
        <p role="alert" className="px-4 py-2 text-destructive">
          {error}
        </p>
      ) : null}
      {expanded ? (
        <div className="workspace-change-diff min-w-0 px-2 pb-3">
          {diff ? (
            diff.text ? (
              <DiffView diff={diff} />
            ) : (
              <p className="px-2 py-3 text-muted-foreground">
                No text diff available.
              </p>
            )
          ) : !error ? (
            <p role="status" className="px-2 py-3 text-muted-foreground">
              Loading diff…
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
