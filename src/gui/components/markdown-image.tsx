import { useEffect, useState } from "react"
import { getAppRpcClient } from "../lib/rpc-client.ts"

// Match the image formats already handled by workspace/readMedia and file
// preview. An image data URL stays inside <img>, never an HTML/document viewer.
const imageMime = /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/i
const imageData = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml))(?:;[^,]*)?,/i

type ImageSource =
  | Readonly<{ kind: "direct"; url: string }>
  | Readonly<{ kind: "workspace"; cwd: string; path: string; fragment: string }>
  | Readonly<{ kind: "unavailable" }>

function relativeWorkspacePath(path: string, cwd: string): string | undefined {
  if (!/^(?:\/|[a-z]:[\\/])/i.test(path)) return path
  const windows = /^[a-z]:[\\/]/i.test(cwd)
  const segments = (value: string) => {
    const result: string[] = []
    for (const segment of (windows ? value.replaceAll("\\", "/") : value).split(
      "/",
    )) {
      if (segment === "..") result.pop()
      else if (segment !== "" && segment !== ".") result.push(segment)
    }
    return result
  }
  const root = segments(cwd)
  const target = segments(path)
  if (
    !root.every((segment, index) =>
      windows
        ? segment.toLowerCase() === target[index]?.toLowerCase()
        : segment === target[index],
    )
  )
    return undefined
  return target.slice(root.length).join("/") || undefined
}

function resolveSource(
  src: string | undefined,
  workspaceRoot: string | undefined,
  documentPath: string | undefined,
): ImageSource {
  if (!src || src.startsWith("#") || src.startsWith("?"))
    return { kind: "unavailable" }
  if (/^(?:https?:\/\/|\/\/)/i.test(src) || imageData.test(src))
    return { kind: "direct", url: src }
  if (!workspaceRoot) return { kind: "unavailable" }
  let path: string
  let fragment = ""
  if (/^file:/i.test(src)) {
    const url = URL.parse(src)
    if (!url || url.hostname) return { kind: "unavailable" }
    path = url.pathname.replace(/^\/([a-z]:\/)/i, "$1")
    fragment = url.hash
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src))
      return { kind: "unavailable" }
    const hash = src.indexOf("#")
    if (hash !== -1) fragment = src.slice(hash)
    path = src.split(/[?#]/, 1)[0] ?? ""
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // As with Markdown file links, malformed escapes remain a literal path.
  }
  if (!path || /^~[\\/]/.test(path)) return { kind: "unavailable" }
  if (documentPath && !/^(?:\/|[a-z]:[\\/])/i.test(path)) {
    const separator = Math.max(
      documentPath.lastIndexOf("/"),
      documentPath.lastIndexOf("\\"),
    )
    path = `${documentPath.slice(0, separator + 1)}${path}`
  }
  // The media RPC accepts only workspace-relative paths. Relativize absolute
  // and document paths without changing cwd; the server still owns canonical
  // symlink containment, supported types, and read limits.
  const relativePath = relativeWorkspacePath(path, workspaceRoot)
  return relativePath === undefined
    ? { kind: "unavailable" }
    : { kind: "workspace", cwd: workspaceRoot, path: relativePath, fragment }
}

export function MarkdownImage({
  src,
  alt = "",
  title,
  workspaceRoot,
  documentPath,
  apiBase,
}: Readonly<{
  src?: string | undefined
  alt?: string | undefined
  title?: string | undefined
  workspaceRoot?: string | undefined
  documentPath?: string | undefined
  apiBase: string
}>) {
  const source = resolveSource(src, workspaceRoot, documentPath)
  // A different file or environment remounts the read, so a pending result can
  // never paint bytes over a newer image. Text-only stream deltas keep it mounted.
  return (
    <ResolvedMarkdownImage
      key={JSON.stringify([apiBase, source])}
      source={source}
      alt={alt}
      title={title}
      apiBase={apiBase}
    />
  )
}

function ResolvedMarkdownImage({
  source,
  alt,
  title,
  apiBase,
}: Readonly<{
  source: ImageSource
  alt: string
  title: string | undefined
  apiBase: string
}>) {
  const cwd = source.kind === "workspace" ? source.cwd : undefined
  const path = source.kind === "workspace" ? source.path : undefined
  const fragment = source.kind === "workspace" ? source.fragment : ""
  const [loadedUrl, setLoadedUrl] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (cwd === undefined || path === undefined) return
    let current = true
    void getAppRpcClient(apiBase)
      .request("workspace/readMedia", { cwd, path })
      .then(
        (media) => {
          if (!current) return
          if (imageMime.test(media.mimeType))
            setLoadedUrl(
              `data:${media.mimeType};base64,${media.base64}${fragment}`,
            )
          else setError("This file is not a supported image.")
        },
        (reason: unknown) => {
          if (current)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not read image.",
            )
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, cwd, path, fragment])

  if (source.kind === "unavailable" || error !== undefined)
    return (
      <span
        data-find-ignore
        title={error}
        className="inline-flex rounded border px-2 py-1 text-sm text-muted-foreground"
      >
        {alt ? `Image unavailable · ${alt}` : "Image unavailable"}
      </span>
    )
  const url = source.kind === "direct" ? source.url : loadedUrl
  if (url === undefined)
    return (
      <span
        data-find-ignore
        role="status"
        className="text-sm text-muted-foreground"
      >
        Loading image{alt ? ` · ${alt}` : ""}…
      </span>
    )
  return (
    <img
      src={url}
      alt={alt}
      title={title}
      loading="lazy"
      decoding="async"
      className="max-h-[32rem] max-w-full rounded object-contain"
      onError={() => setError("Could not load image.")}
    />
  )
}
