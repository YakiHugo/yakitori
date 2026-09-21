import {
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  Link,
  RefreshCw,
  Search,
  X,
} from "lucide-react"
import { memo, useEffect, useState } from "react"
import type {
  WorkspaceFindFilesResponse,
  WorkspaceListResponse,
} from "../../server/workspace.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { languageForPath } from "../lib/syntax-highlighter.ts"
import { useAppStore } from "../store/app-store.ts"
import "./workspace-file-tree.css"

type TreeProps = Readonly<{
  cwd: string
  apiBase: string
  onOpenFile: (path: string) => void
}>

export function WorkspaceFileTree(props: TreeProps) {
  return <FileTree key={`${props.apiBase}:${props.cwd}`} {...props} />
}

function FileTree(props: TreeProps) {
  const [query, setQuery] = useState("")
  const [refresh, setRefresh] = useState(0)
  const activeTurnId = useAppStore((state) => state.execution.activeTurnId)
  const revision = `${refresh}:${activeTurnId ?? ""}`
  const term = query.trim()
  const [result, setResult] = useState<WorkspaceFindFilesResponse>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const invalidate = () => setRefresh((value) => value + 1)
    window.addEventListener("focus", invalidate)
    window.addEventListener("yakitori:workspace-file-saved", invalidate)
    return () => {
      window.removeEventListener("focus", invalidate)
      window.removeEventListener("yakitori:workspace-file-saved", invalidate)
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes the filesystem search.
  useEffect(() => {
    let current = true
    setResult(undefined)
    setError(undefined)
    setLoading(term !== "")
    if (term === "") return
    const timer = window.setTimeout(() => {
      void getAppRpcClient(props.apiBase)
        .request("workspace/findFiles", {
          cwd: props.cwd,
          query: term,
        })
        .then(
          (response) => {
            if (current) {
              setResult(response)
              setLoading(false)
            }
          },
          (cause: unknown) => {
            if (current) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not find files.",
              )
              setLoading(false)
            }
          },
        )
    }, 180)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [props.apiBase, props.cwd, term, revision])
  const rootName = props.cwd.replace(/\/$/, "").split("/").at(-1) || props.cwd
  return (
    <section className="workspace-file-tree" aria-label="Project files">
      <div className="file-tree-toolbar">
        <label className="file-tree-filter">
          <Search size={13} aria-hidden="true" />
          <input
            aria-label="Find files"
            placeholder="Find files…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("")
            }}
          />
          {query !== "" ? (
            <button
              type="button"
              aria-label="Clear file filter"
              onClick={() => setQuery("")}
            >
              <X size={13} />
            </button>
          ) : null}
        </label>
        <button
          type="button"
          className="file-tree-refresh"
          aria-label="Refresh files"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="file-tree-scroll">
        <ul className="file-tree-root" hidden={term !== ""}>
          <Directory {...props} path="." name={rootName} revision={revision} />
        </ul>
        {term !== "" ? (
          <>
            {loading ? (
              <p className="file-tree-hint" role="status">
                Finding files…
              </p>
            ) : null}
            {error ? (
              <p className="file-tree-hint" role="alert">
                {error}
              </p>
            ) : null}
            <ul className="file-tree-results" aria-label="Matching files">
              {result?.paths.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="file-tree-row"
                    title={path}
                    onClick={() => props.onOpenFile(path)}
                  >
                    <FileGlyph path={path} />
                    <span className="file-tree-match">
                      <span>{path.split("/").at(-1)}</span>
                      <small>{path}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {result ? (
              <p className="file-tree-hint">
                {result.paths.length === 0 ? "No files found. " : ""}
                {result.truncated
                  ? "More files may match. Narrow the filter. "
                  : ""}
                Ignored files are excluded.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}

const Directory = memo(function Directory({
  path,
  name,
  revision,
  ...props
}: TreeProps & Readonly<{ path: string; name: string; revision: string }>) {
  const [expanded, setExpanded] = useState(path === ".")
  const [listing, setListing] = useState<WorkspaceListResponse>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision invalidates each expanded directory.
  useEffect(() => {
    if (!expanded) return
    let current = true
    setLoading(true)
    setError(undefined)
    void getAppRpcClient(props.apiBase)
      .request("workspace/list", { cwd: props.cwd, path })
      .then(
        (response) => {
          if (current) {
            setListing(response)
            setLoading(false)
          }
        },
        (cause: unknown) => {
          if (current) {
            setError(
              cause instanceof Error ? cause.message : "Could not list files.",
            )
            setLoading(false)
          }
        },
      )
    return () => {
      current = false
    }
  }, [props.apiBase, props.cwd, path, expanded, revision])
  const Icon = expanded ? FolderOpen : Folder
  return (
    <li>
      <button
        type="button"
        className="file-tree-row file-tree-directory"
        aria-expanded={expanded}
        title={path === "." ? props.cwd : path}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          size={12}
          className="file-tree-chevron"
          aria-hidden="true"
        />
        <Icon size={15} className="file-tree-folder" aria-hidden="true" />
        <span>{name}</span>
      </button>
      {expanded ? (
        <ul className="file-tree-children">
          {listing?.entries.map((entry) =>
            entry.kind === "directory" ? (
              <Directory
                key={entry.path}
                {...props}
                path={entry.path}
                name={entry.name}
                revision={revision}
              />
            ) : (
              <li key={entry.path}>
                <button
                  type="button"
                  className="file-tree-row file-tree-file"
                  disabled={entry.kind === "other"}
                  title={entry.path}
                  onClick={() => props.onOpenFile(entry.path)}
                >
                  <FileGlyph
                    path={entry.path}
                    symlink={entry.kind === "symlink"}
                  />
                  <span>{entry.name}</span>
                </button>
              </li>
            ),
          )}
          {loading ? (
            <li className="file-tree-hint" role="status">
              Loading files…
            </li>
          ) : null}
          {error ? (
            <li className="file-tree-hint" role="alert">
              {error}
            </li>
          ) : null}
          {!loading && listing?.entries.length === 0 ? (
            <li className="file-tree-hint">This directory is empty.</li>
          ) : null}
          {listing?.truncated ? (
            <li className="file-tree-hint">
              Directory listing truncated. Use Find files to locate a file.
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
})

function FileGlyph({
  path,
  symlink,
}: Readonly<{ path: string; symlink?: boolean }>) {
  const language = languageForPath(path)
  const image = /\.(png|jpe?g|gif|webp|ico|svg)$/i.test(path)
  const Icon = symlink
    ? Link
    : image
      ? FileImage
      : language === "markdown"
        ? FileText
        : language === "json" || language === "jsonc"
          ? FileJson2
          : language
            ? FileCode2
            : File
  return (
    <Icon
      size={15}
      aria-hidden="true"
      className="file-tree-file-icon"
      data-language={image ? "image" : (language ?? "text")}
    />
  )
}
