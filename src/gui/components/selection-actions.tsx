import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  type ContextExcerpt,
  isContextSource,
  type RenderedTextAnchor,
} from "../../protocol/input-context.ts"
import { selectionOffsets } from "./excerpt-source.tsx"

type CapturedSelection = {
  excerpt: ContextExcerpt
  source: HTMLElement
  range: Range
  sideChatId?: string
  anchor: RenderedTextAnchor
}

export function SelectionActions({
  readOnlySideChatIds,
  onAddToConversation,
  onAskInSideChat,
}: Readonly<{
  readOnlySideChatIds?: readonly string[]
  onAddToConversation(excerpt: ContextExcerpt, sideChatId?: string): void
  onAskInSideChat(excerpt: ContextExcerpt, sideChatId?: string): void
}>) {
  const [captured, setCaptured] = useState<CapturedSelection>()
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const menu = useRef<HTMLDivElement>(null)
  const readOnlyIds = useRef(readOnlySideChatIds)
  readOnlyIds.current = readOnlySideChatIds

  useLayoutEffect(() => {
    if (
      captured?.sideChatId &&
      readOnlySideChatIds?.includes(captured.sideChatId)
    )
      setCaptured(undefined)
  }, [captured, readOnlySideChatIds])

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
        event.target.closest("[data-excerpt-ui], .selection-actions")
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
        source.closest("[hidden]") ||
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
      const sideChatId = source.closest<HTMLElement>("[data-side-chat-id]")
        ?.dataset.sideChatId
      if (sideChatId && readOnlyIds.current?.includes(sideChatId)) {
        setCaptured(undefined)
        return
      }
      const contextSource = {
        kind,
        label,
        ...(contextSessionId ? { sessionId: contextSessionId } : {}),
        ...(contextMessageId ? { messageId: contextMessageId } : {}),
        ...(contextPath ? { path: contextPath } : {}),
        ...(contextUrl ? { url: contextUrl } : {}),
      }
      if (!isContextSource(contextSource)) {
        setCaptured(undefined)
        return
      }
      const anchor = selectionOffsets(source, range)
      setCaptured({
        excerpt: {
          id: `excerpt_${crypto.randomUUID()}`,
          text,
          source: contextSource,
          anchor,
        },
        source,
        ...(sideChatId ? { sideChatId } : {}),
        range: range.cloneRange(),
        anchor,
      })
    }
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && menu.current?.contains(event.target))
        return
      setCaptured(undefined)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current) {
        event.preventDefault()
        event.stopPropagation()
        window.getSelection()?.removeAllRanges()
        setCaptured(undefined)
      }
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
      window.getSelection()?.removeAllRanges()
    }
  }, [])

  useLayoutEffect(() => {
    if (!captured) return
    const place = () => {
      if (!captured.source.isConnected || captured.source.closest("[hidden]")) {
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

  const actOnSelection = (action: "conversation" | "side") => {
    if (
      !captured?.source.isConnected ||
      (captured.sideChatId !== undefined &&
        readOnlyIds.current?.includes(captured.sideChatId)) ||
      captured.source.closest("[hidden]") ||
      captured.source.textContent?.slice(
        captured.anchor.startOffset,
        captured.anchor.endOffset,
      ) !== captured.excerpt.text
    ) {
      setCaptured(undefined)
      return
    }
    const add =
      action === "conversation" ? onAddToConversation : onAskInSideChat
    if (captured.sideChatId) add(captured.excerpt, captured.sideChatId)
    else add(captured.excerpt)
    window.getSelection()?.removeAllRanges()
    setCaptured(undefined)
  }

  return (
    <>
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
              <button
                type="button"
                onClick={() => actOnSelection("conversation")}
              >
                Quote in conversation
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
