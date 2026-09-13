import { useCallback, useEffect, useRef, useState } from "react"
import { Search } from "lucide-react"
import type { ApiSearchSessionsResponse } from "../../server/protocol.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { SidebarDialog } from "./sidebar-surfaces.tsx"

export function SessionSearch({ onClose }: Readonly<{ onClose(): void }>) {
  const apiBase = useAppStore((state) => state.apiBase)
  const selectSession = useAppStore((state) => state.selectSession)
  const projects = useAppStore((state) => state.projects)
  const [query, setQuery] = useState("")
  const [archived, setArchived] = useState(false)
  const [result, setResult] = useState<ApiSearchSessionsResponse>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [active, setActive] = useState(0)
  const revision = useRef(0)
  const list = useRef<HTMLElement>(null)
  const term = query.trim()
  const fetchPage = useCallback(
    async (requestRevision: number, cursor?: string) => {
      setLoading(true)
      setError(undefined)
      try {
        const response = await getAppRpcClient(apiBase).request(
          "session/search",
          {
            searchTerm: term,
            archived,
            ...(cursor === undefined ? {} : { cursor }),
          },
        )
        if (revision.current !== requestRevision) return
        setResult((previous) => ({
          ...response,
          data:
            cursor === undefined
              ? response.data
              : [...(previous?.data ?? []), ...response.data],
        }))
      } catch (cause) {
        if (revision.current === requestRevision)
          setError(cause instanceof Error ? cause.message : "Search failed.")
      } finally {
        if (revision.current === requestRevision) setLoading(false)
      }
    },
    [apiBase, term, archived],
  )
  useEffect(() => {
    const requestRevision = ++revision.current
    setResult(undefined)
    setActive(0)
    setError(undefined)
    setLoading(term !== "")
    if (term === "") return
    const timer = window.setTimeout(() => void fetchPage(requestRevision), 180)
    return () => {
      window.clearTimeout(timer)
      revision.current += 1
    }
  }, [term, fetchPage])
  const results = result?.data ?? []
  const open = (index: number) => {
    const session = results[index]?.session
    if (!session) return
    onClose()
    void selectSession(session.id, session)
  }
  return (
    <SidebarDialog title="Search sessions" onClose={onClose}>
      <div className="mb-3 flex items-center gap-2 rounded-lg border px-3">
        <Search size={16} className="text-muted-foreground" />
        <input
          aria-label="Search sessions"
          data-autofocus
          placeholder="Search titles and messages"
          value={query}
          onChange={(event) => {
            if (event.target.value.trim() !== term) revision.current += 1
            setQuery(event.target.value)
          }}
          className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter") {
              event.preventDefault()
              open(active)
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              const index = Math.max(
                0,
                Math.min(
                  results.length - 1,
                  active + (event.key === "ArrowDown" ? 1 : -1),
                ),
              )
              setActive(index)
              list.current?.children[index]?.scrollIntoView({
                block: "nearest",
              })
            }
          }}
        />
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => {
            revision.current += 1
            setArchived(event.target.checked)
          }}
        />
        Search archived conversations
      </label>
      <section
        ref={list}
        className="max-h-[50vh] overflow-y-auto"
        aria-label="Search results"
      >
        {results.map(({ session, snippet }, index) => (
          <button
            type="button"
            key={session.navigationId ?? session.id}
            data-active={index === active}
            onMouseEnter={() => setActive(index)}
            onClick={() => open(index)}
            className="search-result"
          >
            <span className="block truncate font-medium">
              {session.title ?? "Untitled session"}
            </span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              {snippet}
            </span>
            <span className="mt-1 block text-[11px] text-muted-foreground">
              {projects.find((project) => project.id === session.projectId)
                ?.name ?? "No project"}
            </span>
          </button>
        ))}
      </section>
      <p role="status" className="mt-3 text-xs text-muted-foreground">
        {loading
          ? "Searching…"
          : (error ??
            (term === ""
              ? "Find a session by its title or a phrase from the conversation."
              : results.length === 0
                ? "No matching sessions"
                : "↑ ↓ to navigate · Enter to open"))}
      </p>
      {error && (
        <button
          type="button"
          className="sidebar-row mt-2"
          onClick={() => void fetchPage(++revision.current)}
        >
          Retry search
        </button>
      )}
      {result?.nextCursor && (
        <button
          type="button"
          disabled={loading}
          className="sidebar-row mt-2"
          onClick={() => void fetchPage(revision.current, result.nextCursor)}
        >
          Show more results
        </button>
      )}
    </SidebarDialog>
  )
}
