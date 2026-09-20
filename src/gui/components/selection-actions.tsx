import { MessageSquare, Quote, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type {
  ContextExcerpt,
  ResponseAnnotation,
  SelectedTextAttachment,
} from "../conversation-context.ts"
import {
  AnnotationLayer,
  findContextSource,
  requestAnnotationEdit,
  selectionOffsets,
} from "./annotation-layer.tsx"

export { AnnotationLayer, requestAnnotationEdit } from "./annotation-layer.tsx"

type CapturedSelection = {
  excerpt: SelectedTextAttachment
  source: HTMLElement
  range: Range
  anchor: ResponseAnnotation["anchor"]
}

export function SelectionActions({
  annotations,
  onAddToConversation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  onAskInSideChat,
}: Readonly<{
  annotations: readonly ResponseAnnotation[]
  onAddToConversation(annotation: ResponseAnnotation): void
  onUpdateAnnotation(annotation: ResponseAnnotation): void
  onRemoveAnnotation(id: string): void
  onAskInSideChat(excerpt: SelectedTextAttachment): void
}>) {
  const [captured, setCaptured] = useState<CapturedSelection>()
  const [createdAnnotationId, setCreatedAnnotationId] = useState<string>()
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const capture = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        event.key !== "Shift" &&
        !event.key.startsWith("Arrow")
      )
        return
      if (
        event.target instanceof Element &&
        event.target.closest("[data-annotation-ui], .selection-actions")
      )
        return
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setCaptured(undefined)
        return
      }
      const range = selection.getRangeAt(0)
      const start =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement
      const end =
        range.endContainer instanceof Element
          ? range.endContainer
          : range.endContainer.parentElement
      const source = start?.closest<HTMLElement>("[data-context-kind]")
      if (
        !source ||
        source !== end?.closest("[data-context-kind]") ||
        start?.closest("input, textarea, [contenteditable=true]") ||
        end?.closest("input, textarea, [contenteditable=true]")
      ) {
        setCaptured(undefined)
        return
      }
      const {
        contextKind: kind,
        contextLabel: label,
        contextSessionId,
        contextMessageId,
        contextPath,
        contextUrl,
      } = source.dataset
      const text = range.toString()
      if (
        (kind !== "message" && kind !== "file" && kind !== "browser") ||
        !label ||
        !text.trim()
      ) {
        setCaptured(undefined)
        return
      }
      setCaptured({
        excerpt: {
          id: `selection_${crypto.randomUUID()}`,
          kind: "selection",
          text,
          source: {
            kind,
            label,
            ...(contextSessionId ? { sessionId: contextSessionId } : {}),
            ...(contextMessageId ? { messageId: contextMessageId } : {}),
            ...(contextPath ? { path: contextPath } : {}),
            ...(contextUrl ? { url: contextUrl } : {}),
          },
        },
        source,
        range: range.cloneRange(),
        anchor: selectionOffsets(source, range),
      })
    }
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && menu.current?.contains(event.target))
        return
      setCaptured(undefined)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCaptured(undefined)
    }
    document.addEventListener("pointerup", capture)
    document.addEventListener("keyup", capture)
    document.addEventListener("pointerdown", close)
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("pointerup", capture)
      document.removeEventListener("keyup", capture)
      document.removeEventListener("pointerdown", close)
      document.removeEventListener("keydown", keydown)
    }
  }, [])

  useLayoutEffect(() => {
    if (!captured) return
    const place = () => {
      if (!captured.source.isConnected) {
        setCaptured(undefined)
        return
      }
      const rect = captured.range.getBoundingClientRect()
      const width = menu.current?.offsetWidth || 280
      const height = menu.current?.offsetHeight || 38
      setPosition({
        top:
          rect.top >= height + 16
            ? rect.top - height - 8
            : Math.min(window.innerHeight - height - 8, rect.bottom + 8),
        left: Math.max(
          8,
          Math.min(
            window.innerWidth - width - 8,
            rect.left + rect.width / 2 - width / 2,
          ),
        ),
      })
    }
    place()
    document.addEventListener("scroll", place, { capture: true, passive: true })
    window.addEventListener("resize", place)
    return () => {
      document.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [captured])

  const actOnSelection = (action: "main" | "side") => {
    if (!captured) return
    if (action === "main") {
      const annotation: ResponseAnnotation = {
        ...captured.excerpt,
        id: `annotation_${crypto.randomUUID()}`,
        kind: "annotation",
        anchor: captured.anchor,
      }
      onAddToConversation(annotation)
      setCreatedAnnotationId(annotation.id)
    } else onAskInSideChat(captured.excerpt)
    setCaptured(undefined)
  }

  return (
    <>
      <AnnotationLayer
        annotations={annotations}
        onChange={onUpdateAnnotation}
        onRemove={onRemoveAnnotation}
        createdAnnotationId={createdAnnotationId}
      />
      {captured
        ? createPortal(
            <div
              ref={menu}
              className="selection-actions"
              style={position}
              role="toolbar"
              aria-label="Selected text actions"
              onPointerDown={(event) => event.preventDefault()}
            >
              <button type="button" onClick={() => actOnSelection("main")}>
                Add to conversation
              </button>
              <span className="selection-actions-divider" />
              <button type="button" onClick={() => actOnSelection("side")}>
                Ask in side chat
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

export function ContextExcerptChips({
  excerpts,
  onRemove,
  onChange,
}: Readonly<{
  excerpts: readonly ContextExcerpt[]
  onRemove?(id: string): void
  onChange?(excerpt: ContextExcerpt): void
}>) {
  const [expanded, setExpanded] = useState<ContextExcerpt["kind"]>()
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const expandedCount = excerpts.filter(
    (excerpt) => excerpt.kind === expanded,
  ).length
  useLayoutEffect(() => {
    if (!expanded || !expandedCount) return
    const place = () => {
      if (!trigger.current || !popover.current) return
      const rect = trigger.current.getBoundingClientRect()
      const { width, height } = popover.current.getBoundingClientRect()
      setPosition({
        top: rect.top >= height + 16 ? rect.top - height - 8 : rect.bottom + 8,
        left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left)),
      })
    }
    place()
    window.addEventListener("resize", place)
    document.addEventListener("scroll", place, { capture: true, passive: true })
    return () => {
      window.removeEventListener("resize", place)
      document.removeEventListener("scroll", place, true)
    }
  }, [expanded, expandedCount])
  useEffect(() => {
    if (!expanded) return
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target) &&
        !popover.current?.contains(event.target)
      )
        setExpanded(undefined)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(undefined)
    }
    document.addEventListener("pointerdown", dismiss)
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      document.removeEventListener("keydown", keydown)
    }
  }, [expanded])
  if (!excerpts.length) return null
  const groups = [
    { kind: "annotation" as const, label: "annotation", icon: MessageSquare },
    { kind: "selection" as const, label: "selected text snippet", icon: Quote },
  ]
  return (
    <div
      className={`context-excerpt-chips${onRemove ? "" : " context-excerpt-chips-readonly"}`}
      ref={container}
    >
      {groups.map(({ kind, label, icon: Icon }) => {
        const items = excerpts.filter((excerpt) => excerpt.kind === kind)
        if (!items.length) return null
        return (
          <div className="context-excerpt-group" key={kind}>
            <button
              type="button"
              className="context-excerpt-pill"
              aria-expanded={expanded === kind}
              onClick={(event) => {
                trigger.current = event.currentTarget
                setExpanded(expanded === kind ? undefined : kind)
              }}
            >
              <Icon size={12} />
              {items.length} {label}
              {items.length === 1 ? "" : "s"}
            </button>
            {expanded === kind
              ? createPortal(
                  <div
                    ref={popover}
                    className="context-excerpt-popover"
                    style={position}
                    role="dialog"
                    aria-label={`${label}s`}
                  >
                    {items.map((excerpt, index) => (
                      <div key={excerpt.id} className="context-excerpt-row">
                        <button
                          type="button"
                          className="context-excerpt-preview"
                          aria-label={`${kind === "annotation" && onChange ? "Edit annotation" : "Go to selected text"} ${index + 1}`}
                          onClick={() => {
                            if (excerpt.kind === "annotation" && onChange)
                              requestAnnotationEdit(excerpt.id)
                            else
                              findContextSource(excerpt.source)?.scrollIntoView(
                                {
                                  block: "center",
                                  behavior: "smooth",
                                },
                              )
                            setExpanded(undefined)
                          }}
                        >
                          <span className="context-excerpt-source">
                            {index + 1} · {excerpt.source.label}
                          </span>
                          <span className="context-excerpt-quote">
                            {excerpt.text}
                          </span>
                          {excerpt.kind === "annotation" && excerpt.comment ? (
                            <span className="context-excerpt-comment">
                              {excerpt.comment}
                            </span>
                          ) : null}
                        </button>
                        {onRemove ? (
                          <button
                            type="button"
                            className="context-excerpt-remove"
                            aria-label={`Remove ${label} ${index + 1}`}
                            onClick={() => onRemove(excerpt.id)}
                          >
                            <X size={13} />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>,
                  document.body,
                )
              : null}
          </div>
        )
      })}
    </div>
  )
}
