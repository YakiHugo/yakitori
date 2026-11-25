import { ArrowUpRight, Globe, Search } from "lucide-react"
import { type Ref, useEffect, useState } from "react"
import { normalizeBrowserUrl } from "../../desktop/workspace-browser-url.ts"
import { translate, useTranslation } from "../i18n/use-translation.ts"
import { isUnmodifiedEscape } from "../lib/escape-key.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import type { WorkspaceView } from "../store/workspace-store.ts"
import { FileGlyph } from "./file-glyph.tsx"
import { workspaceViews } from "./workspace-views.ts"
import "./workspace-launcher.css"

function addressCandidate(value: string) {
  const explicit =
    /^[a-z][a-z\d+.-]*:/i.test(value) ||
    /^(?:localhost|\[::1\]|\d+(?:\.\d+){3})(?::\d+)?(?:[/?#]|$)/i.test(value)
  const domain = /^[a-z\d-]+(?:\.[a-z\d-]+)+(?:[/?#]|$)/i.test(value)
  if (!explicit && !domain) return { explicit }
  try {
    return { explicit, url: normalizeBrowserUrl(value) }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return { explicit, addressError: explicit ? error.message : undefined }
  }
}

export function WorkspaceLauncher({
  active,
  apiBase,
  cwd,
  external,
  inputRef,
  onOpenView,
  onOpenFile,
  onOpenUrl,
}: Readonly<{
  active: boolean
  apiBase: string
  cwd: string | undefined
  external: boolean
  inputRef: Ref<HTMLInputElement> | undefined
  onOpenView: (view: WorkspaceView) => void
  onOpenFile: (path: string, cwd: string) => void
  onOpenUrl: (url: string) => void
}>) {
  const { t } = useTranslation()
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState<{
    term: string
    paths?: string[]
    error?: string
  }>()
  const term = query.trim()
  const { explicit, url, addressError } = addressCandidate(term)
  const searchTerm = cwd && !explicit ? term : ""
  const result = search?.term === searchTerm ? search : undefined
  const searching = Boolean(searchTerm && !result)

  useEffect(() => {
    setSearch(undefined)
    if (!active || !cwd || !searchTerm) return
    let current = true
    const timer = window.setTimeout(() => {
      void getAppRpcClient(apiBase)
        .request("workspace/findFiles", { cwd, query: searchTerm, limit: 8 })
        .then(
          ({ paths }) => {
            if (current) setSearch({ term: searchTerm, paths })
          },
          (error: unknown) => {
            if (current)
              setSearch({
                term: searchTerm,
                error:
                  error instanceof Error
                    ? error.message
                    : translate("File search failed."),
              })
          },
        )
    }, 180)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [active, apiBase, cwd, searchTerm])

  return (
    <div className="workspace-launcher">
      <form
        aria-label={t("Find files or open a URL")}
        onSubmit={(event) => {
          event.preventDefault()
          if (searching) return
          const path = result?.paths?.[0]
          if (path && cwd) onOpenFile(path, cwd)
          else if (url && !result?.error) onOpenUrl(url)
        }}
      >
        <label className="workspace-launcher-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (query && isUnmodifiedEscape(event.nativeEvent)) {
                event.preventDefault()
                setQuery("")
              }
            }}
            aria-label={t("Search files or enter a URL")}
            placeholder={
              cwd ? t("Search files or enter a URL") : t("Enter a URL")
            }
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {term && (
          <div className="workspace-launcher-results">
            {searching && <p role="status">{t("Finding files…")}</p>}
            {(addressError || result?.error) && (
              <p role="alert">{addressError || result?.error}</p>
            )}
            {!searching &&
              !addressError &&
              !result?.error &&
              !result?.paths?.length &&
              !url && (
                <p role="status">
                  {cwd
                    ? t("No matching files")
                    : t("Select a project to search files")}
                </p>
              )}
            {cwd &&
              result?.paths?.map((path) => (
                <button
                  key={path}
                  type="button"
                  title={path}
                  onClick={() => onOpenFile(path, cwd)}
                >
                  <FileGlyph path={path} />
                  <span>{path}</span>
                </button>
              ))}
            {url && (
              <button type="button" title={url} onClick={() => onOpenUrl(url)}>
                <Globe size={15} aria-hidden="true" />
                <span>{url}</span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </form>
      {!term && (
        <section
          className="workspace-launcher-actions"
          aria-label={t("Open in workspace")}
        >
          {(
            [
              "changes",
              "files",
              "browser",
              "computer",
              "chat",
              "agents",
            ] as const
          ).map((view) => {
            const option = workspaceViews[view]
            if (external && "nativeOnly" in option) return null
            const Icon = option.icon
            const disabled = !cwd && "needsProject" in option
            return (
              <button
                key={view}
                type="button"
                disabled={disabled}
                title={disabled ? t("Select a project first") : undefined}
                onClick={() => onOpenView(view)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{t(option.label)}</span>
              </button>
            )
          })}
        </section>
      )}
    </div>
  )
}
