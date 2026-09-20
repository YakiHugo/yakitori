import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { ApiSearchSessionOccurrencesResponse } from "../../server/protocol.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { conversationFindRanges } from "./conversation-find-text.ts"
import "./conversation-find.css"

const findEvent = "yakitori:find-conversation"
type Occurrence = ApiSearchSessionOccurrencesResponse["data"][number]
const emptyMatches: readonly Occurrence[] = []

export function openConversationFind() {
  window.dispatchEvent(new Event(findEvent))
}

export function ConversationFind({
  sessionId,
  contentRef,
  onJump,
}: Readonly<{
  sessionId: string
  contentRef: RefObject<HTMLDivElement | null>
  onJump(range: Range | HTMLElement): void
}>) {
  const apiBase = useAppStore((state) => state.apiBase)
  const inputCount = useAppStore(
    (state) => state.selectedSession?.counts.inputs,
  )
  const activeTurnId = useAppStore((state) => state.execution.activeTurnId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [revision, setRevision] = useState(0)
  const [result, setResult] =
    useState<
      Readonly<{
        term: string
        data: readonly Occurrence[]
        loading: boolean
        error?: string
      }>
    >()
  const [unlocated, setUnlocated] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const lastJump = useRef<string | undefined>(undefined)
  const term = query.trim()
  const current = result?.term === term ? result : undefined
  const matches = current?.data ?? emptyMatches
  const index = Math.min(active, Math.max(0, matches.length - 1))
  const selected = matches[index]
  const occurrenceIndex =
    selected === undefined
      ? 0
      : matches
          .slice(0, index)
          .filter((match) => match.itemId === selected.itemId).length

  const close = useCallback(() => {
    setOpen(false)
    if (restoreFocus.current?.isConnected) restoreFocus.current.focus()
  }, [])
  useEffect(() => {
    const show = () => {
      if (!open)
        restoreFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null
      setOpen(true)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        (event.target instanceof Element && event.target.closest(".cm-editor"))
      )
        return
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault()
        show()
      } else if (open && event.key === "Escape") {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener(findEvent, show)
    window.addEventListener("keydown", keydown)
    return () => {
      window.removeEventListener(findEvent, show)
      window.removeEventListener("keydown", keydown)
    }
  }, [open, close])
  useLayoutEffect(() => {
    if (open) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [open])

  // Server search follows the complete persisted conversation, including
  // history outside the viewport. Its logical scope is prompts and final answers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: admissions, turn boundaries and Retry refresh the persisted search projection.
  useEffect(() => {
    if (!open || term === "") return
    let disposed = false
    setResult({ term, data: [], loading: true })
    const timer = window.setTimeout(async () => {
      const data: Occurrence[] = []
      let cursor: string | undefined
      try {
        do {
          const page = await getAppRpcClient(apiBase).request(
            "session/searchOccurrences",
            {
              sessionId,
              searchTerm: term,
              limit: 100,
              ...(cursor === undefined ? {} : { cursor }),
            },
          )
          if (disposed) return
          data.push(...page.data)
          cursor = page.nextCursor
          setResult({ term, data: [...data], loading: cursor !== undefined })
        } while (cursor !== undefined)
      } catch (cause) {
        if (!disposed)
          setResult({
            term,
            data,
            loading: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not search this conversation.",
          })
      }
    }, 160)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [open, term, apiBase, sessionId, inputCount, activeTurnId, revision])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!open || term === "" || !content || matches.length === 0) {
      lastJump.current = undefined
      setUnlocated(false)
      return
    }
    const supported =
      typeof CSS !== "undefined" &&
      "highlights" in CSS &&
      typeof Highlight !== "undefined"
    let frame: number | undefined
    let activeMessage: HTMLElement | undefined
    const update = () => {
      frame = undefined
      activeMessage?.removeAttribute("data-find-current")
      activeMessage?.removeAttribute("data-find-fallback")
      activeMessage = undefined
      const messages = new Map(
        [
          ...content.querySelectorAll<HTMLElement>(
            '[data-context-kind="message"][data-context-message-id]',
          ),
        ].map((node) => [node.dataset.contextMessageId, node]),
      )
      const highlight = supported ? new Highlight() : undefined
      const activeHighlight = supported ? new Highlight() : undefined
      let activeRange: Range | undefined
      const counts = new Map<string, number>()
      for (const match of matches)
        counts.set(match.itemId, (counts.get(match.itemId) ?? 0) + 1)
      for (const [id, count] of counts) {
        const message = messages.get(id)
        if (!message) continue
        const ranges = conversationFindRanges(message, term)
        // Prompts can display literal Markdown while the persisted search
        // indexes its visible text. Avoid selecting a different occurrence
        // from a link URL or hidden syntax; show its logical snippet instead.
        const exact = ranges.length === count
        if (exact) for (const range of ranges) highlight?.add(range)
        if (id === selected?.itemId) {
          activeMessage = message
          activeRange = exact ? ranges[occurrenceIndex] : undefined
          if (activeRange) activeHighlight?.add(activeRange)
        }
      }
      if (highlight && activeHighlight) {
        CSS.highlights.set("conversation-find", highlight)
        CSS.highlights.set("conversation-find-current", activeHighlight)
      }
      activeMessage?.setAttribute("data-find-current", "")
      activeMessage?.toggleAttribute(
        "data-find-fallback",
        activeRange === undefined || !supported,
      )
      setUnlocated(selected !== undefined && activeRange === undefined)
      const jumpKey = `${term}:${selected?.itemId}:${occurrenceIndex}:${activeRange === undefined ? "message" : "match"}`
      const target = activeRange ?? activeMessage
      if (target && lastJump.current !== jumpKey) {
        // Native details retain their content in the DOM; reveal a matching
        // message before measuring its range.
        let ancestor =
          activeRange?.startContainer.parentElement ?? activeMessage
        while (ancestor && ancestor !== content) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
          if (
            activeRange &&
            ancestor.clientWidth > 0 &&
            ancestor.scrollWidth > ancestor.clientWidth
          ) {
            const bounds = ancestor.getBoundingClientRect()
            const matchBounds = activeRange.getBoundingClientRect()
            if (
              matchBounds.left < bounds.left ||
              matchBounds.right > bounds.right
            ) {
              ancestor.scrollLeft += matchBounds.left - bounds.left - 24
            }
          }
          ancestor = ancestor.parentElement ?? undefined
        }
        onJump(target)
        lastJump.current = jumpKey
      }
    }
    update()
    const observer = new MutationObserver(() => {
      if (frame === undefined) frame = requestAnimationFrame(update)
    })
    observer.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return () => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      activeMessage?.removeAttribute("data-find-current")
      activeMessage?.removeAttribute("data-find-fallback")
      if (supported) {
        CSS.highlights.delete("conversation-find")
        CSS.highlights.delete("conversation-find-current")
      }
    }
  }, [open, term, matches, selected, occurrenceIndex, contentRef, onJump])

  if (!open) return null
  const navigate = (direction: number) => {
    if (matches.length > 0)
      setActive((index + direction + matches.length) % matches.length)
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: A search form owns native submission so Enter cannot navigate the page.
    <form
      className="conversation-find"
      role="search"
      aria-label="Find in conversation"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="conversation-find-row">
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          aria-label="Find in conversation"
          placeholder="Find in conversation"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key !== "Enter") return
            event.preventDefault()
            navigate(event.shiftKey ? -1 : 1)
          }}
        />
        <span
          className="conversation-find-count"
          role="status"
          aria-live="polite"
        >
          {term === ""
            ? ""
            : current?.error
              ? "Search failed"
              : matches.length > 0
                ? `${index + 1} of ${matches.length}${current?.loading ? "+" : ""}`
                : current?.loading || current === undefined
                  ? "Searching…"
                  : "No results"}
        </span>
        <button
          type="button"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={matches.length === 0}
          onClick={() => navigate(-1)}
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={matches.length === 0}
          onClick={() => navigate(1)}
        >
          <ChevronDown size={15} />
        </button>
        <button
          type="button"
          aria-label="Close find"
          title="Close (Escape)"
          onClick={close}
        >
          <X size={15} />
        </button>
      </div>
      {current?.error ? (
        <div className="conversation-find-message" role="alert">
          <span>{current.error}</span>
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : unlocated && selected ? (
        <p className="conversation-find-message">
          {selected.snippet.slice(0, selected.snippetMatchRange.start)}
          <mark>
            {selected.snippet.slice(
              selected.snippetMatchRange.start,
              selected.snippetMatchRange.end,
            )}
          </mark>
          {selected.snippet.slice(selected.snippetMatchRange.end)}
        </p>
      ) : null}
    </form>
  )
}
