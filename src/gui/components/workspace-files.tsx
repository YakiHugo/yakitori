import {
  ArrowLeft,
  ChevronRight,
  File,
  Folder,
  Link,
  RefreshCw,
  SquareArrowOutUpRight,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  WorkspaceListResponse,
  WorkspaceReadResponse,
} from "../../server/workspace.ts"
import { contextSourceAttributes } from "../conversation-context.ts"
import { fileActionLabel, openFileTarget } from "../lib/open-resource.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { CopyIconButton } from "./response-actions.tsx"

const iconButton =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"

export function WorkspaceFiles(
  props: Readonly<{
    cwd: string
    apiBase: string
    onOpenFile?: (path: string) => void
  }>,
) {
  return <FilesBrowser key={`${props.apiBase}:${props.cwd}`} {...props} />
}

function FilesBrowser({
  cwd,
  apiBase,
  onOpenFile,
}: Readonly<{
  cwd: string
  apiBase: string
  onOpenFile?: (path: string) => void
}>) {
  const [path, setPath] = useState("")
  const [file, setFile] = useState<string>()
  const [listing, setListing] = useState<WorkspaceListResponse>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const activeTurnId = useAppStore((state) => state.execution.activeTurnId)
  const rootName = cwd.replace(/\/$/, "").split("/").at(-1) || cwd
  const segments = path.split("/").filter(Boolean)

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly invalidates filesystem data on refresh.
  useEffect(() => {
    let current = true
    setLoading(true)
    setError(undefined)
    setListing(undefined)
    void getAppRpcClient(apiBase)
      .request("workspace/list", { cwd, path: path || "." })
      .then(
        (result) => {
          if (current) {
            setListing(result)
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
  }, [apiBase, cwd, path, revision, activeTurnId])

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  const navigate = (directory: string) => {
    setFile(undefined)
    setPath(directory)
  }

  return (
    <div className="workspace-files flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex min-h-11 items-center gap-1 border-b px-3">
        <button
          type="button"
          className={iconButton}
          aria-label={file ? "Back to directory" : "Parent directory"}
          disabled={!file && path === ""}
          onClick={() =>
            file
              ? setFile(undefined)
              : navigate(segments.slice(0, -1).join("/"))
          }
        >
          <ArrowLeft size={14} />
        </button>
        <nav
          aria-label="File path"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap text-muted-foreground"
        >
          <button
            type="button"
            className="hover:text-foreground"
            title={cwd}
            onClick={() => navigate("")}
          >
            {rootName}
          </button>
          {segments.map((segment, index) => (
            <span
              key={segments.slice(0, index + 1).join("/")}
              className="inline-flex items-center gap-1"
            >
              <ChevronRight size={11} />
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => navigate(segments.slice(0, index + 1).join("/"))}
              >
                {segment}
              </button>
            </span>
          ))}
        </nav>
        <button
          type="button"
          className={iconButton}
          aria-label="Refresh files"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw
            size={13}
            className={loading ? "animate-spin" : undefined}
          />
        </button>
      </div>
      {file ? (
        <WorkspaceFilePreview
          key={`${file}:${revision}:${activeTurnId ?? ""}`}
          cwd={cwd}
          apiBase={apiBase}
          path={file}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {error ? (
            <p role="alert" className="px-2 py-4 text-destructive">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p role="status" className="px-2 py-4 text-muted-foreground">
              Loading files…
            </p>
          ) : null}
          {listing?.entries.map((entry) => {
            const Icon =
              entry.kind === "directory"
                ? Folder
                : entry.kind === "symlink"
                  ? Link
                  : File
            return (
              <button
                type="button"
                key={entry.path}
                disabled={entry.kind === "other"}
                className="group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-foreground/5 disabled:opacity-40"
                title={entry.path}
                onClick={() =>
                  entry.kind === "directory"
                    ? navigate(entry.path)
                    : onOpenFile
                      ? onOpenFile(entry.path)
                      : setFile(entry.path)
                }
              >
                <Icon size={15} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.kind === "directory" ? (
                  <ChevronRight
                    size={12}
                    className="text-muted-foreground/60"
                  />
                ) : null}
              </button>
            )
          })}
          {listing?.entries.length === 0 ? (
            <p className="px-2 py-4 text-muted-foreground">
              This directory is empty.
            </p>
          ) : null}
          {listing?.truncated ? (
            <p className="px-2 py-3 text-muted-foreground">
              Directory listing truncated.
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function WorkspaceFilePreview(
  props: Readonly<{ cwd: string; apiBase: string; path: string }>,
) {
  const activeTurnId = useAppStore((state) => state.execution.activeTurnId)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])
  return (
    <FilePreview
      key={`${props.apiBase}:${props.cwd}:${props.path}:${activeTurnId ?? ""}:${revision}`}
      {...props}
    />
  )
}

function FilePreview({
  cwd,
  apiBase,
  path,
}: Readonly<{ cwd: string; apiBase: string; path: string }>) {
  const [preview, setPreview] = useState<WorkspaceReadResponse>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const request = useRef(0)
  const sessionId = useAppStore((state) => state.selection.sessionId)

  useEffect(() => {
    const id = ++request.current
    void getAppRpcClient(apiBase)
      .request("workspace/read", { cwd, path })
      .then(
        (result) => {
          if (request.current === id) {
            setPreview(result)
            setLoading(false)
          }
        },
        (cause: unknown) => {
          if (request.current === id) {
            setError(
              cause instanceof Error ? cause.message : "Could not read file.",
            )
            setLoading(false)
          }
        },
      )
    return () => {
      request.current += 1
    }
  }, [apiBase, cwd, path])

  const loadMore = async () => {
    if (preview?.nextOffset === undefined || loading) return
    const id = ++request.current
    setLoading(true)
    setError(undefined)
    try {
      const result = await getAppRpcClient(apiBase).request("workspace/read", {
        cwd,
        path,
        offset: preview.nextOffset,
      })
      if (request.current !== id) return
      setPreview({
        ...result,
        offset: preview.offset,
        content: `${preview.content}\n${result.content}`,
      })
    } catch (cause) {
      if (request.current === id)
        setError(
          cause instanceof Error ? cause.message : "Could not load more lines.",
        )
    } finally {
      if (request.current === id) setLoading(false)
    }
  }

  const open = async () => {
    const id = request.current
    try {
      await openFileTarget({ kind: "file", path }, cwd)
    } catch (cause) {
      if (request.current === id)
        setError(
          cause instanceof Error ? cause.message : "Could not open file.",
        )
    }
  }
  const lines =
    preview?.content === "" ? [] : (preview?.content.split("\n") ?? [])
  const absolutePath = path.startsWith("/")
    ? path
    : `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`

  return (
    <div className="workspace-file-preview flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <File size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" title={path}>
          {path.split("/").at(-1)}
        </span>
        <CopyIconButton text={absolutePath} label="path" />
        {window.yakitoriDesktop !== undefined ? (
          <button
            type="button"
            className={iconButton}
            title={fileActionLabel()}
            aria-label={fileActionLabel()}
            onClick={() => void open()}
          >
            <SquareArrowOutUpRight size={13} />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p role="alert" className="px-4 py-3 text-destructive">
            {error}
          </p>
        ) : null}
        {preview?.binary ? (
          <p className="px-4 py-6 text-muted-foreground">
            Binary file · {fileActionLabel().toLowerCase()} to view.
          </p>
        ) : null}
        {preview && !preview.binary ? (
          lines.length === 0 ? (
            <p className="px-4 py-6 text-muted-foreground">
              This file is empty.
            </p>
          ) : (
            <table
              {...contextSourceAttributes({
                kind: "file",
                label: path,
                path: absolutePath,
                ...(sessionId ? { sessionId } : {}),
              })}
              className="w-full border-collapse font-mono text-[11px] leading-5"
            >
              <tbody>
                {lines.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview lines remain in source order
                  <tr key={index}>
                    <td className="w-10 select-none px-3 text-right align-top text-muted-foreground/50">
                      {preview.offset + index}
                    </td>
                    <td className="whitespace-pre pr-4">{line || "\u00a0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
        {loading ? (
          <p role="status" className="px-4 py-3 text-muted-foreground">
            Loading file…
          </p>
        ) : null}
        {preview?.nextOffset !== undefined ? (
          <button
            type="button"
            disabled={loading}
            className="m-3 rounded-md px-3 py-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
            onClick={() => void loadMore()}
          >
            Load more lines
          </button>
        ) : preview?.truncated && !preview.binary ? (
          <p className="px-4 py-3 text-muted-foreground">
            Preview truncated. {fileActionLabel()} to view the full file.
          </p>
        ) : null}
      </div>
    </div>
  )
}
