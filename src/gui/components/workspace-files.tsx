import {
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Image,
  Pencil,
  Presentation,
  SquareArrowOutUpRight,
  WrapText,
} from "lucide-react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import type { WorkspaceReadOfficeResponse } from "../../server/office-preview.ts"
import type {
  WorkspaceReadMediaResponse,
  WorkspaceReadResponse,
} from "../../server/workspace.ts"
import { contextSourceAttributes } from "../conversation-context.ts"
import { fileActionLabel, openFileTarget } from "../lib/open-resource.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { languageForPath } from "../lib/syntax-highlighter.ts"
import { useAppStore } from "../store/app-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { DiffView } from "./cells/diff-view.tsx"
import { DataPreview } from "./data-preview.tsx"
import { FileEditor } from "./file-editor.tsx"
import { HtmlPreview } from "./html-preview.tsx"
import { ImageLightbox } from "./image-lightbox.tsx"
import { MarkdownView } from "./markdown.tsx"
import { CopyIconButton } from "./response-actions.tsx"
import { SourceCode } from "./source-code.tsx"
import { WorkspaceFileTree } from "./workspace-file-tree.tsx"
import "./workspace-files.css"

const PdfPreview = lazy(() =>
  import("./pdf-preview.tsx").then((module) => ({
    default: module.PdfPreview,
  })),
)
const OfficePreview = lazy(() =>
  import("./office-preview.tsx").then((module) => ({
    default: module.OfficePreview,
  })),
)
const mediaExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "pdf",
])
const officeExtensions = new Set(["docx", "xlsx", "pptx"])

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
  const [media, setMedia] = useState<WorkspaceReadMediaResponse>()
  const [office, setOffice] = useState<WorkspaceReadOfficeResponse>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [wrap, setWrap] = useState(false)
  const [mode, setMode] = useState<"source" | "preview">("preview")
  const [lightbox, setLightbox] = useState(false)
  const request = useRef(0)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const extension = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase()
  const isSvg = extension === "svg"
  const isMedia = extension !== undefined && mediaExtensions.has(extension)
  const isOffice = extension !== undefined && officeExtensions.has(extension)

  useEffect(() => {
    const id = ++request.current
    void getAppRpcClient(apiBase)
      .request(
        isOffice
          ? "workspace/readOffice"
          : isMedia
            ? "workspace/readMedia"
            : "workspace/read",
        { cwd, path },
      )
      .then(
        (result) => {
          if (request.current === id) {
            if (isOffice) setOffice(result as WorkspaceReadOfficeResponse)
            else if (isMedia) setMedia(result as WorkspaceReadMediaResponse)
            else setPreview(result as WorkspaceReadResponse)
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
  }, [apiBase, cwd, path, isMedia, isOffice])

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

  const showSource = async () => {
    setMode("source")
    if (!isSvg || preview || loading) return
    const id = request.current
    setLoading(true)
    setError(undefined)
    try {
      const result = await getAppRpcClient(apiBase).request("workspace/read", {
        cwd,
        path,
      })
      if (request.current === id) setPreview(result)
    } catch (cause) {
      if (request.current === id)
        setError(
          cause instanceof Error ? cause.message : "Could not read file.",
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
  const html = language === "html"
  const data =
    extension === "csv" || extension === "json" ? extension : undefined
  const diff = extension === "diff" || extension === "patch"
  const hasRenderedView =
    markdown || html || data !== undefined || diff || isSvg
  const rendered = hasRenderedView && mode === "preview"
  const image = media?.mimeType.startsWith("image/") === true
  const mediaUrl = media
    ? `data:${media.mimeType};base64,${media.base64}`
    : undefined
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
          {image ? (
            <Image size={18} />
          ) : office?.kind === "xlsx" ? (
            <FileSpreadsheet size={18} />
          ) : office?.kind === "pptx" ? (
            <Presentation size={18} />
          ) : markdown ? (
            <FileText size={18} />
          ) : (
            <FileCode2 size={18} />
          )}
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
      {(preview && !preview.binary && lines.length > 0) || (isSvg && media) ? (
        <div className="file-preview-toolbar">
          {hasRenderedView ? (
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
                onClick={() => void showSource()}
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
            {preview ? (
              <CopyIconButton text={preview.content} label="file content" />
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="file-preview-viewport min-h-0 flex-1 overflow-auto">
        {error ? (
          <p role="alert" className="px-4 py-3 text-destructive">
            {error}
          </p>
        ) : null}
        {preview?.binary && (!isSvg || !rendered) ? (
          <div className="file-preview-empty">
            <File size={28} aria-hidden="true" />
            <strong>No text preview</strong>
            <p>Binary file · {fileActionLabel().toLowerCase()} to view.</p>
          </div>
        ) : null}
        {office ? (
          <Suspense
            fallback={
              <p role="status" className="px-4 py-3 text-muted-foreground">
                Loading document viewer…
              </p>
            }
          >
            <OfficePreview document={office} />
          </Suspense>
        ) : image && mediaUrl && (!isSvg || rendered) ? (
          <div className="file-preview-image" data-vector={isSvg || undefined}>
            <button
              type="button"
              aria-label={`Zoom ${path}`}
              onClick={() => setLightbox(true)}
            >
              <img src={mediaUrl} alt={path.split("/").at(-1) ?? path} />
            </button>
          </div>
        ) : media?.mimeType === "application/pdf" ? (
          <Suspense
            fallback={
              <p role="status" className="px-4 py-3 text-muted-foreground">
                Loading PDF viewer…
              </p>
            }
          >
            <PdfPreview base64={media.base64} />
          </Suspense>
        ) : null}
        {preview && !preview.binary && (!isSvg || !rendered) ? (
          lines.length === 0 ? (
            <p className="file-preview-empty">This file is empty.</p>
          ) : (
            <div {...source}>
              {rendered && markdown ? (
                <MarkdownView
                  text={preview.content}
                  workspaceRoot={cwd}
                  documentPath={absolutePath}
                  className="markdown file-preview-markdown"
                />
              ) : rendered && html ? (
                <HtmlPreview
                  content={preview.content}
                  truncated={preview.truncated}
                />
              ) : rendered && data ? (
                <DataPreview
                  kind={data}
                  content={preview.content}
                  truncated={preview.truncated}
                />
              ) : rendered && diff ? (
                <DiffView
                  diff={{ text: preview.content, truncated: preview.truncated }}
                  path={path}
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
        {preview?.nextOffset !== undefined && (!isSvg || !rendered) ? (
          <button
            type="button"
            disabled={loading}
            className="file-preview-load-more"
            onClick={() => void loadMore()}
          >
            Load more lines
          </button>
        ) : preview?.truncated && !preview.binary && (!isSvg || !rendered) ? (
          <p className="px-4 py-3 text-muted-foreground">
            Preview truncated. {fileActionLabel()} to view the full file.
          </p>
        ) : null}
      </div>
      {preview && !preview.binary && (!isSvg || !rendered) ? (
        <div className="file-preview-status">
          <span>
            {lines.length.toLocaleString()}{" "}
            {lines.length === 1 ? "line" : "lines"}
            {preview.truncated ? " loaded · Partial file" : ""}
          </span>
          <span>Read only</span>
        </div>
      ) : null}
      {lightbox && mediaUrl ? (
        <ImageLightbox
          src={mediaUrl}
          name={path.split("/").at(-1) ?? path}
          onClose={() => setLightbox(false)}
        />
      ) : null}
    </div>
  )
}
