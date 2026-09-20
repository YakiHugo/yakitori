import {
  File,
  FileCode2,
  FileText,
  Pencil,
  SquareArrowOutUpRight,
  WrapText,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { WorkspaceReadResponse } from "../../server/workspace.ts"
import { contextSourceAttributes } from "../conversation-context.ts"
import { fileActionLabel, openFileTarget } from "../lib/open-resource.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { languageForPath } from "../lib/syntax-highlighter.ts"
import { useAppStore } from "../store/app-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { MarkdownView } from "./markdown.tsx"
import { CopyIconButton } from "./response-actions.tsx"
import { SourceCode } from "./source-code.tsx"
import { FileEditor } from "./file-editor.tsx"
import { WorkspaceFileTree } from "./workspace-file-tree.tsx"
import "./workspace-files.css"

const iconButton =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"

export function WorkspaceFiles(
  props: Readonly<{
    cwd: string
    apiBase: string
    onOpenFile?: (path: string) => void
  }>,
) {
  return (
    <WorkspaceFileTree
      {...props}
      onOpenFile={
        props.onOpenFile ??
        ((path) => useWorkspaceStore.getState().openFile(path, props.cwd))
      }
    />
  )
}

export function WorkspaceFilePreview(
  props: Readonly<{
    cwd: string
    apiBase: string
    path: string
    onDirtyChange?: (dirty: boolean) => void
  }>,
) {
  const [editing, setEditing] = useState(false)
  const activeTurnId = useAppStore((state) => state.execution.activeTurnId)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener("focus", refresh)
    window.addEventListener("yakitori:workspace-file-saved", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      window.removeEventListener("yakitori:workspace-file-saved", refresh)
    }
  }, [])
  if (editing)
    return (
      <FileEditor
        {...props}
        onClose={() => {
          setEditing(false)
          setRevision((value) => value + 1)
        }}
      />
    )
  return (
    <FilePreview
      key={`${props.apiBase}:${props.cwd}:${props.path}:${activeTurnId ?? ""}:${revision}`}
      {...props}
      onEdit={() => setEditing(true)}
    />
  )
}

function FilePreview({
  cwd,
  apiBase,
  path,
  onEdit,
}: Readonly<{ cwd: string; apiBase: string; path: string; onEdit(): void }>) {
  const [preview, setPreview] = useState<WorkspaceReadResponse>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [wrap, setWrap] = useState(false)
  const [mode, setMode] = useState<"source" | "preview">("preview")
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
  const language = languageForPath(path)
  const markdown = language === "markdown"
  const rendered = markdown && mode === "preview"
  const source = contextSourceAttributes({
    kind: "file",
    label: path,
    path: absolutePath,
    ...(sessionId ? { sessionId } : {}),
  })

  return (
    <div className="workspace-file-preview flex min-h-0 flex-1 flex-col">
      <div className="file-preview-heading">
        <div className="file-preview-emblem" aria-hidden="true">
          {markdown ? <FileText size={18} /> : <FileCode2 size={18} />}
        </div>
        <div className="file-preview-identity">
          <strong title={path}>{path.split("/").at(-1)}</strong>
          <span title={absolutePath}>{absolutePath}</span>
        </div>
        <CopyIconButton text={absolutePath} label="path" />
        {preview && !preview.binary ? (
          <button
            type="button"
            className={iconButton}
            title="Edit file"
            aria-label="Edit file"
            onClick={onEdit}
          >
            <Pencil size={14} />
          </button>
        ) : null}
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
      {preview && !preview.binary && lines.length > 0 ? (
        <div className="file-preview-toolbar">
          {markdown ? (
            <fieldset className="file-preview-modes" aria-label="File view">
              <button
                type="button"
                aria-pressed={rendered}
                onClick={() => setMode("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                aria-pressed={!rendered}
                onClick={() => setMode("source")}
              >
                Source
              </button>
            </fieldset>
          ) : (
            <span className="file-preview-language">
              {language ?? "Plain text"}
            </span>
          )}
          <div className="file-preview-actions">
            {!rendered ? (
              <button
                type="button"
                className={iconButton}
                aria-label="Wrap lines"
                aria-pressed={wrap}
                title="Wrap lines"
                onClick={() => setWrap((value) => !value)}
              >
                <WrapText size={15} />
              </button>
            ) : null}
            <CopyIconButton text={preview.content} label="file content" />
          </div>
        </div>
      ) : null}
      <div className="file-preview-viewport min-h-0 flex-1 overflow-auto">
        {error ? (
          <p role="alert" className="px-4 py-3 text-destructive">
            {error}
          </p>
        ) : null}
        {preview?.binary ? (
          <div className="file-preview-empty">
            <File size={28} aria-hidden="true" />
            <strong>No text preview</strong>
            <p>Binary file · {fileActionLabel().toLowerCase()} to view.</p>
          </div>
        ) : null}
        {preview && !preview.binary ? (
          lines.length === 0 ? (
            <p className="file-preview-empty">This file is empty.</p>
          ) : (
            <div {...source}>
              {rendered ? (
                <MarkdownView
                  text={preview.content}
                  workspaceRoot={cwd}
                  documentPath={absolutePath}
                  className="markdown file-preview-markdown"
                />
              ) : (
                <SourceCode
                  code={preview.content}
                  path={path}
                  offset={preview.offset}
                  wrap={wrap}
                />
              )}
            </div>
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
            className="file-preview-load-more"
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
      {preview && !preview.binary ? (
        <div className="file-preview-status">
          <span>
            {lines.length.toLocaleString()}{" "}
            {lines.length === 1 ? "line" : "lines"}
            {preview.truncated ? " loaded · Partial file" : ""}
          </span>
          <span>Read only</span>
        </div>
      ) : null}
    </div>
  )
}
