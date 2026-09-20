import type { MouseEvent, ReactNode } from "react"
import { isValidElement, memo, useEffect, useMemo, useState } from "react"
import type { Components } from "react-markdown"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { HighlighterCore } from "shiki/core"
import { openFileTarget, openUrlTarget } from "../lib/open-resource.ts"
import {
  type BundledLanguage,
  normalizeLanguage,
  useHighlighter,
} from "../lib/syntax-highlighter.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { CopyIconButton } from "./response-actions.tsx"

// Model streams commonly deliver several deltas within one animation window;
// this brief quiet period coalesces them while keeping completed blocks prompt.
const highlightSettleMs = 120

function highlight(
  highlighter: HighlighterCore,
  code: string,
  language: string,
): string | undefined {
  try {
    return highlighter.codeToHtml(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
  } catch {
    return undefined
  }
}

function FencedCode({
  code,
  language,
}: {
  readonly code: string
  readonly language: string | undefined
}) {
  const normalized =
    language === undefined ? undefined : normalizeLanguage(language)
  const highlighter = useHighlighter(normalized)
  const [highlighted, setHighlighted] = useState<{
    readonly code: string
    readonly language: BundledLanguage
    readonly html: string
  }>()
  useEffect(() => {
    if (highlighter === undefined || normalized === undefined) return
    // Stream deltas replace this timer, so the renderer stays cheap and shows
    // current plain text until the block has settled.
    const timer = window.setTimeout(() => {
      const html = highlight(highlighter, code, normalized)
      if (html !== undefined)
        setHighlighted({ code, language: normalized, html })
    }, highlightSettleMs)
    return () => window.clearTimeout(timer)
  }, [highlighter, code, normalized])
  const html =
    highlighted?.code === code && highlighted.language === normalized
      ? highlighted.html
      : undefined
  return (
    <div className="group/code relative min-w-0">
      <div className="absolute top-2 right-2 z-10 rounded-md bg-background/90 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
        <CopyIconButton text={code} label="code" />
      </div>
      {html === undefined ? (
        <pre>
          <code>{code}</code>
        </pre>
      ) : (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes the code text when generating this markup.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}

function MarkdownPre({ children }: { readonly children?: ReactNode }) {
  const codeProps = isValidElement(children)
    ? (children.props as { className?: unknown; children?: unknown })
    : undefined
  const code =
    typeof codeProps?.children === "string" ? codeProps.children : undefined
  if (code === undefined) return <pre>{children}</pre>
  const language =
    typeof codeProps?.className === "string"
      ? /language-([\w#+-]+)/.exec(codeProps.className)?.[1]
      : undefined
  return <FencedCode code={code} language={language} />
}

function parseFileHref(href: string): { path: string; line?: number } {
  let decoded = href
  try {
    decoded = decodeURIComponent(href)
  } catch {
    // Malformed percent escapes: use the raw href as the path.
  }
  const match = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(decoded)
  const path = match?.[1] ?? decoded
  const line = match?.[2] === undefined ? undefined : Number(match[2])
  return line === undefined ? { path } : { path, line }
}

function MarkdownLink({
  href,
  children,
  workspaceRoot,
  documentPath,
}: Readonly<{
  href?: string | undefined
  children?: ReactNode
  workspaceRoot?: string | undefined
  documentPath?: string | undefined
}>) {
  const [openError, setOpenError] = useState<string>()
  if (href === undefined) return <span>{children}</span>
  if (/^https?:\/\//i.test(href)) {
    return (
      <a
        href={href}
        onClick={(event: MouseEvent) => {
          event.preventDefault()
          if (event.metaKey || event.ctrlKey)
            void openUrlTarget({ kind: "url", url: href })
          else useWorkspaceStore.getState().openBrowser(href)
        }}
      >
        {children}
      </a>
    )
  }
  if (href.startsWith("#")) return <a href={href}>{children}</a>
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(href)
  if (hasScheme && !/^file:/i.test(href)) {
    // mailto:, intent:, and other schemes never navigate the app shell.
    return (
      <a
        href={href}
        onClick={(event: MouseEvent) => {
          event.preventDefault()
        }}
      >
        {children}
      </a>
    )
  }
  const file = parseFileHref(href.replace(/^file:\/\//i, ""))
  if (file.path === "") return <span>{children}</span>
  // File documents resolve links from their directory; conversation links
  // continue to resolve from the workspace. Normalize before opening a tab so
  // parent links don't become a path outside that tab's filesystem root.
  if (documentPath?.startsWith("/") && !file.path.startsWith("/")) {
    const segments = documentPath.split("/").slice(0, -1)
    for (const segment of file.path.split("/")) {
      if (segment === "..") segments.pop()
      else if (segment !== "" && segment !== ".") segments.push(segment)
    }
    file.path = `/${segments.filter(Boolean).join("/")}`
  }
  return (
    <a
      href={href}
      title={openError ?? href}
      onClick={(event: MouseEvent) => {
        event.preventDefault()
        setOpenError(undefined)
        if (!event.metaKey && !event.ctrlKey) {
          if (file.path.startsWith("/")) {
            const separator = file.path.lastIndexOf("/")
            useWorkspaceStore
              .getState()
              .openFile(
                file.path.slice(separator + 1),
                file.path.slice(0, separator) || "/",
              )
            return
          }
          if (workspaceRoot) {
            useWorkspaceStore.getState().openFile(file.path, workspaceRoot)
            return
          }
        }
        void openFileTarget(
          {
            kind: "file",
            path: file.path,
            ...(file.line === undefined ? {} : { line: file.line }),
          },
          workspaceRoot,
        ).catch((reason: unknown) => {
          setOpenError(
            reason instanceof Error ? reason.message : "Could not open file.",
          )
        })
      }}
    >
      {children}
    </a>
  )
}

function createMarkdownComponents(
  workspaceRoot: string | undefined,
  documentPath: string | undefined,
): Components {
  return {
    a: (props) => (
      <MarkdownLink
        {...props}
        workspaceRoot={workspaceRoot}
        documentPath={documentPath}
      />
    ),
    pre: MarkdownPre,
  }
}

export const MarkdownView = memo(function MarkdownView({
  text,
  className,
  workspaceRoot,
  documentPath,
}: Readonly<{
  text: string
  className?: string
  workspaceRoot?: string | undefined
  documentPath?: string | undefined
}>) {
  const components = useMemo(
    () => createMarkdownComponents(workspaceRoot, documentPath),
    [workspaceRoot, documentPath],
  )
  return (
    <div className={className}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
})
