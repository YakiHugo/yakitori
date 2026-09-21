import { type CSSProperties, useEffect, useMemo, useState } from "react"
import type { HighlighterCore, ThemedTokenWithVariants } from "shiki/core"

// Keep the engine, themes, and individual grammars lazy across all code views.
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

export type BundledLanguage = keyof typeof languageLoaders

export function normalizeLanguage(label: string): BundledLanguage | undefined {
  const lowered = label.trim().toLowerCase()
  const resolved = Object.hasOwn(languageAliases, lowered)
    ? (languageAliases[lowered] ?? lowered)
    : lowered
  return Object.hasOwn(languageLoaders, resolved)
    ? (resolved as BundledLanguage)
    : undefined
}

const fileLanguages: Readonly<Record<string, string>> = {
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hxx: "cpp",
  mts: "typescript",
  cts: "typescript",
  md: "markdown",
  mdx: "markdown",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  htm: "html",
  svg: "xml",
  gql: "graphql",
  patch: "diff",
  conf: "ini",
}

export function languageForPath(path: string): BundledLanguage | undefined {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ""
  if (name === "dockerfile" || name.startsWith("dockerfile."))
    return "dockerfile"
  if (name === "makefile" || name === "gnumakefile") return "makefile"
  if (name === ".bashrc" || name === ".zshrc" || name === ".profile")
    return "shellscript"
  const extension = name.includes(".") ? name.split(".").at(-1) : undefined
  return extension === undefined
    ? undefined
    : normalizeLanguage(
        Object.hasOwn(fileLanguages, extension)
          ? (fileLanguages[extension] ?? extension)
          : extension,
      )
}

let highlighterPromise: Promise<HighlighterCore> | undefined
let resolvedHighlighter: HighlighterCore | undefined
const loadedLanguages = new Set<BundledLanguage>()
const languagePromises = new Map<BundledLanguage, Promise<HighlighterCore>>()

function loadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/dist/themes/github-light.mjs"),
    import("shiki/dist/themes/github-dark.mjs"),
  ])
    .then(async ([core, engineModule, light, dark]) => {
      const highlighter = await core.createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: engineModule.createJavaScriptRegexEngine(),
      })
      resolvedHighlighter = highlighter
      return highlighter
    })
    .catch((error: unknown) => {
      // Failed lazy chunks can retry on a later mount.
      highlighterPromise = undefined
      throw error
    })
  return highlighterPromise
}

export function loadLanguage(
  language: BundledLanguage,
): Promise<HighlighterCore> {
  const existing = languagePromises.get(language)
  if (existing !== undefined) return existing
  const pending = loadHighlighter()
    .then(async (highlighter) => {
      if (!loadedLanguages.has(language)) {
        const grammar = await languageLoaders[language]()
        await highlighter.loadLanguage(grammar.default)
        loadedLanguages.add(language)
      }
      return highlighter
    })
    .catch((error: unknown) => {
      languagePromises.delete(language)
      throw error
    })
  languagePromises.set(language, pending)
  return pending
}

export function useHighlighter(
  language: BundledLanguage | undefined,
): HighlighterCore | undefined {
  const [loaded, setLoaded] =
    useState<
      Readonly<{ language: BundledLanguage; highlighter: HighlighterCore }>
    >()
  useEffect(() => {
    if (language === undefined) return
    if (resolvedHighlighter !== undefined && loadedLanguages.has(language)) {
      setLoaded({ language, highlighter: resolvedHighlighter })
      return
    }
    let active = true
    void loadLanguage(language).then(
      (highlighter) => {
        if (active) setLoaded({ language, highlighter })
      },
      () => {
        // Plain fallback stays; a later mount retries the load.
      },
    )
    return () => {
      active = false
    }
  }, [language])
  return loaded !== undefined && loaded.language === language
    ? loaded.highlighter
    : undefined
}

export function useSyntaxTokens(
  code: string,
  language: BundledLanguage | undefined,
): ThemedTokenWithVariants[][] | undefined {
  const highlightLanguage = useMemo(() => {
    if (language === undefined) return undefined
    // Implementation safety bounds from Codex's source highlighter: avoid
    // main-thread grammar work on large previews and pathological long lines.
    // The entire source remains available as plain text.
    const maxBytes = 512 * 1024
    const maxLines = 10_000
    const maxLineBytes = 4 * 1024
    if (code.length > maxBytes) return undefined
    const encoded = new TextEncoder().encode(code)
    if (encoded.length > maxBytes) return undefined
    let lines = 1
    let lineBytes = 0
    for (const byte of encoded) {
      if (byte === 10) {
        lines += 1
        lineBytes = 0
        if (lines > maxLines) return undefined
      } else if (++lineBytes > maxLineBytes) {
        return undefined
      }
    }
    return language
  }, [code, language])
  const highlighter = useHighlighter(highlightLanguage)
  return useMemo(
    () =>
      highlighter === undefined || highlightLanguage === undefined
        ? undefined
        : highlighter.codeToTokensWithThemes(code, {
            lang: highlightLanguage,
            themes: { light: "github-light", dark: "github-dark" },
          }),
    [code, highlightLanguage, highlighter],
  )
}

export function syntaxTokenStyle(
  token: ThemedTokenWithVariants,
): CSSProperties {
  const fontStyle = token.variants.light?.fontStyle ?? 0
  return {
    "--shiki-light": token.variants.light?.color,
    "--shiki-dark": token.variants.dark?.color,
    fontStyle: fontStyle & 1 ? "italic" : undefined,
    fontWeight: fontStyle & 2 ? "bold" : undefined,
    textDecoration: fontStyle & 4 ? "underline" : undefined,
  } as CSSProperties
}
