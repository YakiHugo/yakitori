import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import type {
  ContextExcerpt,
  ContextSource,
} from "../../protocol/input-context.ts"

export const editExcerptEvent = "yakitori:edit-excerpt"
const highlightName = "yakitori-excerpts"
export const revealContextSourceEvent = "yakitori:reveal-context-source"
export type ContextSourceNavigation = Readonly<{
  source: ContextSource
  options: ScrollIntoViewOptions
}>
export type ExcerptEditRequest = Readonly<{
  ownerId: string
  excerptId: string
}>

export function requestExcerptEdit(request: ExcerptEditRequest) {
  window.dispatchEvent(new CustomEvent(editExcerptEvent, { detail: request }))
}

export function findContextSource(
  source: ContextSource,
  includeHidden = false,
): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-context-kind]"),
  ).find((element) => {
    if (
      (!includeHidden && element.closest("[hidden]")) ||
      element.dataset.contextKind !== source.kind
    )
      return false
    if (source.kind === "message")
      return (
        element.dataset.contextSessionId === source.sessionId &&
        element.dataset.contextMessageId === source.messageId
      )
    if (source.kind === "file")
      return (
        element.dataset.contextPath === source.path &&
        element.dataset.contextSessionId === source.sessionId
      )
    return element.dataset.contextUrl === source.url
  })
}

export function scrollToContextSource(
  source: ContextSource,
  options: ScrollIntoViewOptions,
) {
  const element = findContextSource(source)
  if (element) element.scrollIntoView(options)
  else
    window.dispatchEvent(
      new CustomEvent<ContextSourceNavigation>(revealContextSourceEvent, {
        detail: { source, options },
      }),
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
export function resolveExcerptRange(
  source: HTMLElement,
  excerpt: ContextExcerpt,
): Range | undefined {
  if (!excerpt.anchor) return undefined
  const { startOffset, endOffset } = excerpt.anchor
  if (source.textContent?.slice(startOffset, endOffset) !== excerpt.text)
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

export type ExcerptHighlight = Readonly<{
  excerpt: ContextExcerpt
  ownerId: string
  number: number
  conversation: string
}>

export function ExcerptSourceLayer({
  items,
}: Readonly<{ items: readonly ExcerptHighlight[] }>) {
  const [located, setLocated] = useState<
    (ExcerptHighlight & { rectangles: Rect[] })[]
  >([])
  const supportsHighlight =
    typeof Highlight !== "undefined" &&
    typeof CSS !== "undefined" &&
    !!CSS.highlights
  useEffect(() => {
    if (!items.length) {
      setLocated([])
      return
    }
    let frame = 0
    const observedSources = new Set<HTMLElement>()
    const measure = () => {
      const ranges: Range[] = []
      const sources = new Set<HTMLElement>()
      const next = items.flatMap((item) => {
        const { excerpt } = item
        const source = findContextSource(excerpt.source)
        if (source) sources.add(source)
        const range = source && resolveExcerptRange(source, excerpt)
        if (!source || !range) return []
        ranges.push(range)
        return [
          {
            ...item,
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
          return !element?.closest("[data-excerpt-ui]")
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
  }, [items, supportsHighlight])

  return createPortal(
    <div data-excerpt-ui="" className="excerpt-source-layer">
      {located.flatMap(
        ({ excerpt, ownerId, number, conversation, rectangles }) => {
          if (!rectangles.length) return []
          return [
            ...(!supportsHighlight
              ? rectangles.map((rect) => (
                  <span
                    key={`${ownerId}:${excerpt.id}:${rect.top}:${rect.left}:${rect.width}:${rect.height}`}
                    className="excerpt-highlight"
                    style={rect}
                  />
                ))
              : []),
            <button
              key={`${ownerId}:${excerpt.id}`}
              type="button"
              className="excerpt-marker"
              aria-label={`Open excerpt ${number} in ${conversation}`}
              title={[conversation, excerpt.comment]
                .filter(Boolean)
                .join(" · ")}
              style={{
                top: Math.max(
                  0,
                  Math.min(...rectangles.map((rect) => rect.top)) - 25,
                ),
                left: Math.min(
                  window.innerWidth - 25,
                  Math.max(
                    ...rectangles.map((rect) => rect.left + rect.width),
                  ) - 12.5,
                ),
              }}
              onClick={() =>
                requestExcerptEdit({ ownerId, excerptId: excerpt.id })
              }
            >
              {number}
            </button>,
          ]
        },
      )}
    </div>,
    document.body,
  )
}
