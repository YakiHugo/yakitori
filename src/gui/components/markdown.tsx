import { isValidElement, useEffect, useMemo, useState } from "react"
import type { MouseEvent, ReactNode } from "react"
import Markdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { HighlighterCore } from "shiki/core"
import { openFileTarget, openUrlTarget } from "../lib/open-resource.ts"

// Canonical shiki grammars bundled for fenced code blocks; anything else
// falls back to plain rendering. Each entry is its own lazy module.
const languageLoaders = {
  c: () => import("shiki/dist/langs/c.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  csharp: () => import("shiki/dist/langs/csharp.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  dart: () => import("shiki/dist/langs/dart.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  dockerfile: () => import("shiki/dist/langs/dockerfile.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  graphql: () => import("shiki/dist/langs/graphql.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  ini: () => import("shiki/dist/langs/ini.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  jsonc: () => import("shiki/dist/langs/jsonc.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  kotlin: () => import("shiki/dist/langs/kotlin.mjs"),
  lua: () => import("shiki/dist/langs/lua.mjs"),
  makefile: () => import("shiki/dist/langs/makefile.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  php: () => import("shiki/dist/langs/php.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  ruby: () => import("shiki/dist/langs/ruby.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  svelte: () => import("shiki/dist/langs/svelte.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  vue: () => import("shiki/dist/langs/vue.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
}

// Fence labels that map to a bundled grammar.
const languageAliases: Readonly<Record<string, string>> = {
  bash: "shellscript",
  cjs: "javascript",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  docker: "dockerfile",
  js: "javascript",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  yml: "yaml",
  zsh: "shellscript",
}

function normalizeLanguage(label: string): string | undefined {
  const lowered = label.trim().toLowerCase()
  const resolved = languageAliases[lowered] ?? lowered
  return resolved in languageLoaders ? resolved : undefined
}

let highlighterPromise: Promise<HighlighterCore> | undefined
let resolvedHighlighter: HighlighterCore | undefined

// Shiki ships as a lazy chunk: grammars and themes load only when a fenced
// code block first renders.
function loadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/dist/themes/github-light.mjs"),
    import("shiki/dist/themes/github-dark.mjs"),
    Promise.all(
      Object.values(languageLoaders).map((load) =>
        load().then((module) => module.default),
      ),
    ),
  ])
    .then(async ([core, engineModule, light, dark, languages]) => {
      const highlighter = await core.createHighlighterCore({
        themes: [light.default, dark.default],
        langs: languages.flat(),
        engine: engineModule.createJavaScriptRegexEngine(),
      })
      resolvedHighlighter = highlighter
      return highlighter
    })
    .catch((error: unknown) => {
      // A failed lazy chunk (e.g. a stale build after a deploy) must not
      // disable highlighting forever: the next fenced block retries.
      highlighterPromise = undefined
      throw error
    })
  return highlighterPromise
}

function useHighlighter(): HighlighterCore | undefined {
  const [highlighter, setHighlighter] = useState(resolvedHighlighter)
  useEffect(() => {
    if (highlighter !== undefined) return
    let active = true
    void loadHighlighter().then(
      (loaded) => {
        if (active) setHighlighter(loaded)
      },
      () => {
        // Plain fallback stays; a later mount retries the load.
      },
    )
    return () => {
      active = false
    }
  }, [highlighter])
  return highlighter
}

// Streaming re-renders a block per token; the cache is capped so
// intermediate snapshots cannot grow memory unbounded.
const highlightCache = new Map<string, string>()
const highlightCacheLimit = 200

function highlightCached(
  highlighter: HighlighterCore,
  code: string,
  language: string,
): string | undefined {
  const key = `${language} ${code}`
  const cached = highlightCache.get(key)
  if (cached !== undefined) return cached
  let html: string
  try {
    html = highlighter.codeToHtml(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
  } catch {
    return undefined
  }
  if (highlightCache.size >= highlightCacheLimit) {
    const oldest = highlightCache.keys().next()
    if (!oldest.done) highlightCache.delete(oldest.value)
  }
  highlightCache.set(key, html)
  return html
}

function FencedCode({
  code,
  language,
}: {
  readonly code: string
  readonly language: string | undefined
}) {
  const highlighter = useHighlighter()
  const normalized =
    language === undefined ? undefined : normalizeLanguage(language)
  const html = useMemo(
    () =>
      highlighter === undefined || normalized === undefined
        ? undefined
        : highlightCached(highlighter, code, normalized),
    [highlighter, code, normalized],
  )
  if (html === undefined) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    )
  }
  // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes the code text when generating this markup.
  return <div dangerouslySetInnerHTML={{ __html: html }} />
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
}: {
  readonly href?: string | undefined
  readonly children?: ReactNode
  readonly workspaceRoot?: string | undefined
}) {
  const [openError, setOpenError] = useState<string>()
  if (href === undefined) return <span>{children}</span>
  if (/^https?:\/\//i.test(href)) {
    return (
      <a
        href={href}
        onClick={(event: MouseEvent) => {
          event.preventDefault()
          void openUrlTarget({ kind: "url", url: href })
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
  return (
    <a
      href={href}
      title={openError ?? href}
      onClick={(event: MouseEvent) => {
        event.preventDefault()
        setOpenError(undefined)
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
): Components {
  return {
    a: (props) => <MarkdownLink {...props} workspaceRoot={workspaceRoot} />,
    pre: MarkdownPre,
  }
}

export function MarkdownView({
  text,
  className,
  workspaceRoot,
}: {
  readonly text: string
  readonly className?: string
  readonly workspaceRoot?: string | undefined
}) {
  const components = useMemo(
    () => createMarkdownComponents(workspaceRoot),
    [workspaceRoot],
  )
  return (
    <div className={className}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
