import { CornerUpLeft, Quote, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ContextExcerpt } from "../../protocol/input-context.ts"
import {
  type ExcerptEditRequest,
  editExcerptEvent,
  findContextSource,
  resolveExcerptRange,
  scrollToContextSource,
} from "./excerpt-source.tsx"

export function ContextExcerptCards({
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
  const [editing, setEditing] = useState<{
    id: string
    originalComment: string | undefined
  }>()
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const container = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const current = useRef({ excerpts, ownerId })
  current.current = { excerpts, ownerId }
  const active = excerpts.find((excerpt) => excerpt.id === editing?.id)
  const open = (excerpt: ContextExcerpt) =>
    setEditing({ id: excerpt.id, originalComment: excerpt.comment })
  useEffect(() => {
    if (!ownerId) return
    const edit = (event: Event) => {
      const request = (event as CustomEvent<ExcerptEditRequest>).detail
      if (request.ownerId !== current.current.ownerId) return
      const excerpt = current.current.excerpts.find(
        (item) => item.id === request.excerptId,
      )
      if (excerpt)
        setEditing({ id: excerpt.id, originalComment: excerpt.comment })
    }
    window.addEventListener(editExcerptEvent, edit)
    return () => window.removeEventListener(editExcerptEvent, edit)
  }, [ownerId])
  useLayoutEffect(() => {
    if (!active) return
    const place = () => {
      const trigger = Array.from(
        container.current?.querySelectorAll<HTMLButtonElement>(
          "[data-excerpt-id]",
        ) ?? [],
      ).find((element) => element.dataset.excerptId === active.id)
      if (!trigger || !popover.current) return
      const rect = trigger.getBoundingClientRect()
      const { width, height } = popover.current.getBoundingClientRect()
      setPosition({
        top: Math.max(
          8,
          rect.top >= height + 16
            ? rect.top - height - 8
            : Math.min(window.innerHeight - height - 8, rect.bottom + 8),
        ),
        left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left)),
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
  }, [active])
  const activeId = active?.id
  const editable = onChange !== undefined
  useEffect(() => {
    if (!activeId) return
    const trigger = Array.from(
      container.current?.querySelectorAll<HTMLButtonElement>(
        "[data-excerpt-id]",
      ) ?? [],
    ).find((element) => element.dataset.excerptId === activeId)
    if (editable) input.current?.focus({ preventScroll: true })
    else popover.current?.focus({ preventScroll: true })
    return () => {
      if (
        trigger?.isConnected &&
        (document.activeElement === document.body ||
          popover.current?.contains(document.activeElement))
      )
        trigger.focus({ preventScroll: true })
    }
  }, [activeId, editable])
  useEffect(() => {
    if (!active) return
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target) &&
        !popover.current?.contains(event.target)
      )
        setEditing(undefined)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      if (onChange && editing && active.comment !== editing.originalComment) {
        const { comment: _comment, ...excerpt } = active
        onChange(
          editing.originalComment === undefined
            ? excerpt
            : { ...excerpt, comment: editing.originalComment },
        )
      }
      setEditing(undefined)
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", keydown)
    }
  }, [active, editing, onChange])
  if (!excerpts.length) return null
  const save = () => {
    if (!active || !editing || !onChange) return
    const { comment: _comment, ...excerpt } = active
    const comment = active.comment?.trim() || undefined
    if (comment !== active.comment)
      onChange(comment === undefined ? excerpt : { ...excerpt, comment })
    setEditing(undefined)
  }
  const sourceElement = active && findContextSource(active.source)
  const located =
    active &&
    sourceElement &&
    active.anchor &&
    resolveExcerptRange(sourceElement, active)
  return (
    <div
      data-excerpt-ui=""
      ref={container}
      className={`context-excerpt-cards${onRemove ? "" : " context-excerpt-cards-readonly"}`}
    >
      {excerpts.map((excerpt, index) => (
        <div key={excerpt.id} className="context-excerpt-card">
          <button
            type="button"
            data-excerpt-id={excerpt.id}
            className="context-excerpt-preview"
            aria-label={`Open excerpt ${index + 1}: ${excerpt.source.label}`}
            aria-expanded={active?.id === excerpt.id}
            onClick={() =>
              active?.id === excerpt.id ? setEditing(undefined) : open(excerpt)
            }
          >
            <span className="context-excerpt-source">
              <Quote size={12} />
              {index + 1} · {excerpt.source.label}
            </span>
            <span className="context-excerpt-quote">{excerpt.text}</span>
            {excerpt.comment ? (
              <span className="context-excerpt-comment">{excerpt.comment}</span>
            ) : null}
          </button>
          {onRemove ? (
            <button
              type="button"
              className="context-excerpt-remove"
              aria-label={`Remove excerpt ${index + 1}`}
              onClick={() => onRemove(excerpt.id)}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      ))}
      {active && editing
        ? createPortal(
            <div
              data-excerpt-ui=""
              ref={popover}
              className="context-excerpt-popover"
              role="dialog"
              tabIndex={-1}
              aria-label="Excerpt details"
              style={position}
            >
              <div className="context-excerpt-source">
                {active.source.label}
              </div>
              {active.source.kind !== "message" ? (
                <div className="context-excerpt-location">
                  {active.source.kind === "file"
                    ? active.source.path
                    : active.source.url}
                </div>
              ) : null}
              <blockquote>{active.text}</blockquote>
              {onChange ? (
                <textarea
                  ref={input}
                  aria-label="Excerpt comment (optional)"
                  placeholder="Add a comment (optional)"
                  rows={3}
                  value={active.comment ?? ""}
                  onChange={(event) => {
                    // Draft changes must reach the owner before a pending send ACK
                    // can consume its submitted snapshot.
                    const { comment: _comment, ...excerpt } = active
                    onChange(
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
              ) : active.comment ? (
                <p>{active.comment}</p>
              ) : null}
              {active.anchor && !located ? (
                <p className="context-excerpt-notice">
                  The original passage cannot be located precisely. Your excerpt
                  is preserved.
                </p>
              ) : null}
              <div className="context-excerpt-actions">
                <button
                  type="button"
                  onClick={() => {
                    scrollToContextSource(active.source, {
                      block: "center",
                      behavior: "smooth",
                    })
                    setEditing(undefined)
                  }}
                >
                  <CornerUpLeft size={13} />
                  Go to source
                </button>
                {onChange ? (
                  <button type="button" onClick={save}>
                    Save comment
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="Close excerpt details"
                  onClick={() => setEditing(undefined)}
                >
                  <X size={13} />
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
