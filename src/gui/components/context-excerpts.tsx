import {
  ArrowUp,
  CornerUpLeft,
  MessageSquareQuote,
  Pencil,
  Trash2,
  X,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import type { ContextExcerpt } from "../../protocol/input-context.ts"
import { isUnmodifiedEscape } from "../lib/escape-key.ts"
import {
  type ExcerptEditRequest,
  editExcerptEvent,
  findContextSource,
  resolveExcerptRange,
  scrollToContextSource,
  visibleExcerptRectangles,
} from "./excerpt-source.tsx"

export function ContextExcerpts({
  excerpts,
  ownerId,
  onRemove,
  onChange,
}: Readonly<{
  excerpts: readonly ContextExcerpt[]
  ownerId?: string | undefined
  onRemove?(id: string): void
  onChange?(excerpt: ContextExcerpt): void
}>) {
  const [summary, setSummary] = useState<{ pinned: boolean }>()
  const [editing, setEditing] = useState<{
    id: string
    originalComment: string | undefined
    creating?: boolean
  }>()
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const current = useRef({ excerpts, ownerId })
  current.current = { excerpts, ownerId }
  const active = excerpts.find((excerpt) => excerpt.id === editing?.id)
  const open = Boolean(excerpts.length && (summary || active))
  const focusComposer = () =>
    container.current
      ?.closest("[data-composer-surface]")
      ?.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')
      ?.focus({ preventScroll: true })
  const edit = useCallback((excerpt: ContextExcerpt, creating = false) => {
    setSummary(undefined)
    setEditing({ id: excerpt.id, originalComment: excerpt.comment, creating })
  }, [])
  const cancel = () => {
    if (active && editing) {
      if (editing.creating) onRemove?.(active.id)
      else if (onChange && active.comment !== editing.originalComment) {
        const { comment: _comment, ...excerpt } = active
        onChange(
          editing.originalComment === undefined
            ? excerpt
            : { ...excerpt, comment: editing.originalComment },
        )
      }
      focusComposer()
    } else if (summary?.pinned) trigger.current?.focus({ preventScroll: true })
    setEditing(undefined)
    setSummary(undefined)
  }
  const save = () => {
    if (!active || !onChange) return
    const { comment: _comment, ...excerpt } = active
    const comment = active.comment?.trim() || undefined
    if (comment !== active.comment)
      onChange(comment === undefined ? excerpt : { ...excerpt, comment })
    focusComposer()
    setEditing(undefined)
  }
  useEffect(() => {
    if (!ownerId) return
    const receive = (event: Event) => {
      const request = (event as CustomEvent<ExcerptEditRequest>).detail
      if (request.ownerId !== current.current.ownerId) return
      const excerpt = current.current.excerpts.find(
        (item) => item.id === request.excerptId,
      )
      if (excerpt) edit(excerpt, request.creating === true)
    }
    window.addEventListener(editExcerptEvent, receive)
    return () => window.removeEventListener(editExcerptEvent, receive)
  }, [ownerId, edit])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  useEffect(() => {
    if (editing && !active) setEditing(undefined)
    if (!excerpts.length) setSummary(undefined)
  }, [editing, active, excerpts.length])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!trigger.current || !popover.current) return
      const source = active && findContextSource(active.source)
      const range = source && active && resolveExcerptRange(source, active)
      const rectangles =
        source && range ? visibleExcerptRectangles(range, source) : []
      const rect = rectangles.length
        ? {
            top: Math.min(...rectangles.map((item) => item.top)),
            bottom: Math.max(
              ...rectangles.map((item) => item.top + item.height),
            ),
            left: Math.min(...rectangles.map((item) => item.left)),
            right: Math.max(
              ...rectangles.map((item) => item.left + item.width),
            ),
          }
        : trigger.current.getBoundingClientRect()
      const { width, height } = popover.current.getBoundingClientRect()
      const composer = container.current
        ?.closest("[data-composer-surface]")
        ?.getBoundingClientRect()
      const bottom =
        rectangles.length && composer && rect.bottom <= composer.top
          ? composer.top - 8
          : window.innerHeight - 8
      // Leave the numbered source marker visible above the highlighted passage.
      const gapAbove = rectangles.length ? 32 : 8
      setPosition({
        top: Math.max(
          8,
          Math.min(
            bottom - height,
            rect.top >= height + gapAbove + 8
              ? rect.top - height - gapAbove
              : rect.bottom + 8,
          ),
        ),
        left: Math.max(
          8,
          Math.min(
            window.innerWidth - width - 8,
            rectangles.length
              ? (rect.left + rect.right - width) / 2
              : rect.left,
          ),
        ),
      })
    }
    place()
    const observer = new ResizeObserver(place)
    if (popover.current) observer.observe(popover.current)
    window.addEventListener("resize", place)
    document.addEventListener("scroll", place, { capture: true, passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", place)
      document.removeEventListener("scroll", place, true)
    }
  }, [open, active])
  useLayoutEffect(() => {
    if (!active || !input.current) return
    input.current.style.height = "auto"
    input.current.style.height = `${Math.min(160, input.current.scrollHeight)}px`
  }, [active])
  useEffect(() => {
    if (active?.id) input.current?.focus({ preventScroll: true })
    else if (summary?.pinned) popover.current?.focus({ preventScroll: true })
  }, [active?.id, summary?.pinned])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target) &&
        !popover.current?.contains(event.target)
      ) {
        setEditing(undefined)
        setSummary(undefined)
      }
    }
    const keydown = (event: KeyboardEvent) => {
      if (!isUnmodifiedEscape(event)) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", keydown)
    }
  })
  if (!excerpts.length) return null
  const leavePreview = () => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(
      () => setSummary((value) => (value?.pinned ? value : undefined)),
      150,
    )
  }
  return (
    <div
      data-excerpt-ui=""
      ref={container}
      className={`context-excerpts${onRemove ? "" : " context-excerpts-readonly"}`}
    >
      <button
        type="button"
        ref={trigger}
        className="context-excerpt-pill"
        aria-label={`${excerpts.length} ${excerpts.length === 1 ? "annotation" : "annotations"}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(summary && open)}
        onMouseEnter={() => {
          clearTimeout(hoverTimer.current)
          if (!editing) setSummary((value) => value ?? { pinned: false })
        }}
        onMouseLeave={leavePreview}
        onClick={() => {
          setEditing(undefined)
          setSummary((value) => (value?.pinned ? undefined : { pinned: true }))
        }}
      >
        <MessageSquareQuote size={14} />
        {excerpts.length} {excerpts.length === 1 ? "annotation" : "annotations"}
      </button>
      {open
        ? createPortal(
            <div
              data-excerpt-ui=""
              ref={popover}
              className={`context-excerpt-popover ${active ? "context-excerpt-editor" : "context-excerpt-summary"}`}
              role="dialog"
              tabIndex={-1}
              aria-label={active ? "Excerpt comment" : "Annotations"}
              style={position}
              onFocusCapture={() => {
                clearTimeout(hoverTimer.current)
                if (!active)
                  setSummary((value) =>
                    value?.pinned ? value : { pinned: true },
                  )
              }}
              onMouseEnter={() => clearTimeout(hoverTimer.current)}
              onMouseLeave={leavePreview}
            >
              {active ? (
                <>
                  <textarea
                    ref={input}
                    aria-label="Excerpt comment (optional)"
                    placeholder="Add an optional comment…"
                    rows={2}
                    value={active.comment ?? ""}
                    onChange={(event) => {
                      // Keep edits in the owner before a pending send ACK consumes its snapshot.
                      const { comment: _comment, ...excerpt } = active
                      onChange?.(
                        event.target.value
                          ? { ...excerpt, comment: event.target.value }
                          : excerpt,
                      )
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault()
                        save()
                      }
                    }}
                  />
                  <div className="context-excerpt-editor-actions">
                    <span className="context-excerpt-number">
                      {excerpts.indexOf(active) + 1}
                    </span>
                    {onRemove ? (
                      <button
                        type="button"
                        aria-label={`Remove excerpt ${excerpts.indexOf(active) + 1}`}
                        title="Remove annotation"
                        onClick={() => {
                          onRemove(active.id)
                          setEditing(undefined)
                          focusComposer()
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label="Cancel comment"
                      title="Cancel · Esc"
                      onClick={cancel}
                    >
                      <X size={15} />
                    </button>
                    <button
                      type="button"
                      className="context-excerpt-save"
                      aria-label="Save comment"
                      title="Save · Enter"
                      onClick={save}
                    >
                      <ArrowUp size={16} />
                    </button>
                  </div>
                </>
              ) : (
                <ol className="context-excerpt-list">
                  {excerpts.map((excerpt, index) => {
                    const source = findContextSource(excerpt.source)
                    const located =
                      source && resolveExcerptRange(source, excerpt)
                    return (
                      <li key={excerpt.id}>
                        <div className="context-excerpt-heading">
                          <span className="context-excerpt-number">
                            {index + 1}
                          </span>
                          <button
                            type="button"
                            className="context-excerpt-source"
                            aria-label={`Go to source for excerpt ${index + 1}`}
                            title={
                              excerpt.source.kind === "file"
                                ? excerpt.source.path
                                : excerpt.source.kind === "browser"
                                  ? excerpt.source.url
                                  : excerpt.source.label
                            }
                            onClick={() => {
                              scrollToContextSource(excerpt.source, {
                                block: "center",
                                behavior: "smooth",
                              })
                              setSummary(undefined)
                            }}
                          >
                            <span>{excerpt.source.label}</span>
                            <CornerUpLeft size={12} />
                          </button>
                          {onChange ? (
                            <button
                              type="button"
                              className="context-excerpt-icon"
                              aria-label={`Edit excerpt ${index + 1}: ${excerpt.source.label}`}
                              title="Edit comment"
                              onClick={() => edit(excerpt)}
                            >
                              <Pencil size={13} />
                            </button>
                          ) : null}
                          {onRemove ? (
                            <button
                              type="button"
                              className="context-excerpt-icon"
                              aria-label={`Remove excerpt ${index + 1}`}
                              title="Remove annotation"
                              onClick={() => {
                                onRemove(excerpt.id)
                                if (excerpts.length === 1) {
                                  setSummary(undefined)
                                  focusComposer()
                                } else
                                  popover.current?.focus({
                                    preventScroll: true,
                                  })
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          ) : null}
                        </div>
                        <blockquote>{excerpt.text}</blockquote>
                        {excerpt.comment ? (
                          <p className="context-excerpt-comment">
                            {excerpt.comment}
                          </p>
                        ) : null}
                        {excerpt.anchor && !located ? (
                          <p className="context-excerpt-notice">
                            The original passage cannot be located precisely.
                            Your excerpt is preserved.
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
