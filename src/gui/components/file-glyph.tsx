import { File, FileCode2, FileImage, Link } from "lucide-react"
import type { SimpleIcon } from "simple-icons"
import {
  siC,
  siCplusplus,
  siCss,
  siDart,
  siDocker,
  siGnubash,
  siGo,
  siGraphql,
  siHtml5,
  siJavascript,
  siJson,
  siKotlin,
  siLua,
  siMarkdown,
  siOpenjdk,
  siPhp,
  siPython,
  siReact,
  siRuby,
  siRust,
  siSharp,
  siSvelte,
  siSwift,
  siToml,
  siTypescript,
  siVuedotjs,
  siXml,
  siYaml,
} from "simple-icons"
import type { BundledLanguage } from "../lib/syntax-highlighter.ts"
import { languageForPath } from "../lib/syntax-highlighter.ts"
import { cn } from "../lib/utils.ts"

// Official brand icons (simple-icons) for languages with a known logo; other
// files keep a generic Lucide glyph tinted by data-language (see globals.css).
const languageIcons: Partial<Record<BundledLanguage, SimpleIcon>> = {
  c: siC,
  cpp: siCplusplus,
  csharp: siSharp,
  css: siCss,
  dart: siDart,
  dockerfile: siDocker,
  go: siGo,
  graphql: siGraphql,
  html: siHtml5,
  java: siOpenjdk,
  javascript: siJavascript,
  json: siJson,
  jsonc: siJson,
  jsx: siReact,
  kotlin: siKotlin,
  lua: siLua,
  markdown: siMarkdown,
  php: siPhp,
  python: siPython,
  ruby: siRuby,
  rust: siRust,
  shellscript: siGnubash,
  svelte: siSvelte,
  swift: siSwift,
  toml: siToml,
  tsx: siReact,
  typescript: siTypescript,
  vue: siVuedotjs,
  xml: siXml,
  yaml: siYaml,
}

// Pure-black brand marks would vanish in dark mode; they inherit the glyph
// tint (currentColor) instead of their official hex.
const neutralLanguages: ReadonlySet<BundledLanguage> = new Set([
  "java",
  "json",
  "jsonc",
  "markdown",
  "rust",
])

export function FileGlyph({
  path,
  symlink,
  className,
}: Readonly<{ path: string; symlink?: boolean; className?: string }>) {
  const language = languageForPath(path)
  const image = /\.(png|jpe?g|gif|webp|ico|svg)$/i.test(path)
  const iconClass = cn("file-glyph", className)
  const languageKey = image ? "image" : (language ?? "text")
  const brand =
    image || language === undefined ? undefined : languageIcons[language]
  if (brand !== undefined && !symlink) {
    return (
      <svg
        aria-hidden="true"
        className={iconClass}
        data-language={languageKey}
        viewBox="0 0 24 24"
        width="15"
        height="15"
      >
        <path
          d={brand.path}
          fill={
            neutralLanguages.has(language as BundledLanguage)
              ? "currentColor"
              : `#${brand.hex}`
          }
        />
      </svg>
    )
  }
  const Icon = symlink ? Link : image ? FileImage : language ? FileCode2 : File
  return (
    <Icon
      size={15}
      aria-hidden="true"
      className={iconClass}
      data-language={languageKey}
    />
  )
}
