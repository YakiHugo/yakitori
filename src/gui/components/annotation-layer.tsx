import { Check } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type {
  ContextSource,
  ResponseAnnotation,
} from "../conversation-context.ts"

const editEvent = "yakitori:edit-annotation"
const highlightName = "yakitori-response-annotations"

export function requestAnnotationEdit(id: string) {
  window.dispatchEvent(new CustomEvent(editEvent, { detail: id }))
}

export function findContextSource(
  source: ContextSource,
): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-context-kind]"),
  ).find(
    (element) =>
      element.dataset.contextKind === source.kind &&
      element.dataset.contextLabel === source.label &&
      element.dataset.contextSessionId === source.sessionId &&
      element.dataset.contextMessageId === source.messageId &&
      element.dataset.contextPath === source.path &&
      element.dataset.contextUrl === source.url,
  )
}

export function selectionOffsets(source: HTMLElement, range: Range) {
  const before = document.createRange()
  before.selectNodeContents(source)
  before.setEnd(range.startContainer, range.startOffset)
  const startOffset = before.toString().length
  return { startOffset, endOffset: startOffset + range.toString().length }
}

/** Text offsets survive markdown rerenders; changed text must never paint a different quote. */
export function resolveAnnotationRange(
  source: HTMLElement,
  annotation: ResponseAnnotation,
): Range | undefined {
  const { startOffset, endOffset } = annotation.anchor
  if (source.textContent?.slice(startOffset, endOffset) !== annotation.text)
    return undefined
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (!started && startOffset < offset + length) {
      range.setStart(node, startOffset - offset)
      started = true
    }
    if (started && endOffset <= offset + length) {
      range.setEnd(node, endOffset - offset)
      return range
    }
    offset += length
  }
  return undefined
}

type Rect = { top: number; left: number; width: number; height: number }
type LocatedAnnotation = {
  annotation: ResponseAnnotation
  number: number
  rectangles: Rect[]
}

function visibleRectangles(range: Range, source: HTMLElement): Rect[] {
  let bounds = {
    top: 0,
    left: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  }
  for (
    let parent = source.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent)
    if (
      /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)
    ) {
      const rect = parent.getBoundingClientRect()
      bounds = {
        top: Math.max(bounds.top, rect.top),
        left: Math.max(bounds.left, rect.left),
        right: Math.min(bounds.right, rect.right),
        bottom: Math.min(bounds.bottom, rect.bottom),
      }
    }
  }
  return Array.from(range.getClientRects()).flatMap((rect) => {
    const top = Math.max(bounds.top, rect.top)
    const left = Math.max(bounds.left, rect.left)
    const right = Math.min(bounds.right, rect.right)
    const bottom = Math.min(bounds.bottom, rect.bottom)
    return right > left && bottom > top
      ? [{ top, left, width: right - left, height: bottom - top }]
      : []
  })
}

export function AnnotationLayer({
  annotations,
  onChange,
  onRemove,
  createdAnnotationId,
}: Readonly<{
  annotations: readonly ResponseAnnotation[]
  onChange(annotation: ResponseAnnotation): void
  onRemove(id: string): void
  createdAnnotationId?: string | undefined
}>) {
  const [located, setLocated] = useState<LocatedAnnotation[]>([])
  const [editing, setEditing] = useState<{
    id: string
    originalComment: string | undefined
    creating: boolean
  }>()
  const input = useRef<HTMLTextAreaElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const [editorPosition, setEditorPosition] = useState({ top: 0, left: 0 })
  const current = useRef({ annotations, onChange, onRemove })
  current.current = { annotations, onChange, onRemove }
  const supportsHighlight =
    typeof Highlight !== "undefined" &&
    typeof CSS !== "undefined" &&
    !!CSS.highlights

  useEffect(() => {
    if (!annotations.length) {
      setLocated([])
      return
    }
    let frame = 0
    const observedSources = new Set<HTMLElement>()
    const measure = () => {
      const ranges: Range[] = []
      const sources = new Set<HTMLElement>()
      const next = annotations.flatMap((annotation, index) => {
        const source = findContextSource(annotation.source)
        if (source) sources.add(source)
        const range = source && resolveAnnotationRange(source, annotation)
        if (!source || !range) return []
        ranges.push(range)
        return [
          {
            annotation,
            number: index + 1,
            rectangles: visibleRectangles(range, source),
          },
        ]
      })
      if (supportsHighlight)
        CSS.highlights.set(highlightName, new Highlight(...ranges))
      for (const source of observedSources) {
        if (!sources.has(source)) {
          resizeObserver.unobserve(source)
          observedSources.delete(source)
        }
      }
      for (const source of sources) {
        if (!observedSources.has(source)) {
          resizeObserver.observe(source)
          observedSources.add(source)
        }
      }
      setLocated(next)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) => {
          const element =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement
          return !element?.closest("[data-annotation-ui]")
        })
      )
        schedule()
    })
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      attributes: true,
      subtree: true,
    })
    const resizeObserver = new ResizeObserver(schedule)
    window.addEventListener("resize", schedule)
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    })
    measure()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      resizeObserver.disconnect()
      window.removeEventListener("resize", schedule)
      document.removeEventListener("scroll", schedule, true)
      if (supportsHighlight) CSS.highlights.delete(highlightName)
    }
  }, [annotations, supportsHighlight])

  useEffect(() => {
    const edit = (event: Event) => {
      const id: unknown = (event as CustomEvent<unknown>).detail
      const annotation = current.current.annotations.find(
        (item) => item.id === id,
      )
      if (!annotation) return
      findContextSource(annotation.source)?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      })
      setEditing({
        id: annotation.id,
        originalComment: annotation.comment,
        creating: false,
      })
    }
    window.addEventListener(editEvent, edit)
    return () => window.removeEventListener(editEvent, edit)
  }, [])

  useEffect(() => {
    const annotation = current.current.annotations.find(
      (item) => item.id === createdAnnotationId,
    )
    if (annotation)
      setEditing({
        id: annotation.id,
        originalComment: annotation.comment,
        creating: true,
      })
  }, [createdAnnotationId])

  const active = annotations.find((annotation) => annotation.id === editing?.id)
  const activeLocation = located.find(
    (item) => item.annotation.id === active?.id,
  )
  const lastRect = activeLocation?.rectangles.at(-1)
  const activeId = active?.id
  const visible = !!lastRect
  useLayoutEffect(() => {
    if (!lastRect || !editor.current) return
    const height = editor.current.offsetHeight || 44
    const width = editor.current.offsetWidth || 300
    setEditorPosition({
      top:
        lastRect.top + lastRect.height + height + 18 < window.innerHeight
          ? lastRect.top + lastRect.height + 10
          : Math.max(8, lastRect.top - height - 10),
      left: Math.max(8, Math.min(window.innerWidth - width - 8, lastRect.left)),
    })
  }, [lastRect])
  useEffect(() => {
    if (activeId && visible) input.current?.focus({ preventScroll: true })
    if (!activeId) setEditing(undefined)
  }, [activeId, visible])

  useEffect(() => {
    if (!editing) return
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest(
          "[data-annotation-ui], .context-excerpt-chips, .context-excerpt-popover",
        )
      )
        return
      const annotation = current.current.annotations.find(
        (item) => item.id === editing.id,
      )
      // Codex keeps an annotation when returning to its source or the composer.
      const preserve = event.target.closest(
        "[data-context-kind], [data-composer-surface]",
      )
      if (editing.creating && !preserve && !annotation?.comment?.trim())
        current.current.onRemove(editing.id)
      setEditing(undefined)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      const annotation = current.current.annotations.find(
        (item) => item.id === editing.id,
      )
      if (editing.creating) current.current.onRemove(editing.id)
      else if (annotation) {
        const { comment: _comment, ...withoutComment } = annotation
        current.current.onChange(
          editing.originalComment === undefined
            ? withoutComment
            : { ...annotation, comment: editing.originalComment },
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
  }, [editing])

  return createPortal(
    <div data-annotation-ui="" className="annotation-layer">
      {located.flatMap(({ annotation, number, rectangles }) => {
        const last = rectangles.at(-1)
        if (!last || !annotations.some((item) => item.id === annotation.id))
          return []
        return [
          ...(!supportsHighlight
            ? rectangles.map((rect) => (
                <span
                  key={`${annotation.id}-${rect.top}-${rect.left}-${rect.width}-${rect.height}`}
                  className="annotation-highlight"
                  style={rect}
                />
              ))
            : []),
          <button
            key={annotation.id}
            type="button"
            className="annotation-marker"
            aria-label={`Edit annotation ${number}`}
            aria-expanded={active?.id === annotation.id}
            title={annotation.comment}
            style={{
              top: Math.max(
                0,
                Math.min(...rectangles.map((rect) => rect.top)) - 25,
              ),
              left: Math.min(
                window.innerWidth - 25,
                Math.max(...rectangles.map((rect) => rect.left + rect.width)) -
                  12.5,
              ),
            }}
            onClick={() => {
              if (editing?.id !== annotation.id)
                setEditing({
                  id: annotation.id,
                  originalComment: annotation.comment,
                  creating: false,
                })
            }}
          >
            {number}
          </button>,
        ]
      })}
      {active && editing && lastRect ? (
        <div
          ref={editor}
          className="annotation-editor"
          role="dialog"
          aria-label="Annotation comment"
          style={editorPosition}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              setEditing(undefined)
            }
          }}
        >
          <textarea
            ref={input}
            aria-label="Annotation comment (optional)"
            placeholder="Add a comment (optional)"
            rows={1}
            value={active.comment ?? ""}
            onChange={(event) =>
              onChange({ ...active, comment: event.target.value })
            }
          />
          <button
            type="button"
            className="annotation-editor-done"
            aria-label="Done"
            title="Save annotation"
            onClick={() => setEditing(undefined)}
          >
            <Check size={14} />
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
