import { useTranslation } from "../i18n/use-translation.ts"
import { ArrowDown } from "lucide-react"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { ExecutionEntry } from "../execution-view.ts"
import { ConversationScrollContext } from "../hooks/conversation-scroll-context.ts"
import { usePinnedScroll } from "../hooks/use-pinned-scroll.ts"
import { cn } from "../lib/utils.ts"
import {
  selectCurrentThreadId,
  useAppStore,
  useExecutionView,
} from "../store/app-store.ts"
import { ConversationFind } from "./conversation-find.tsx"
import { ConversationNavigation } from "./conversation-navigation.tsx"
import {
  type ContextSourceNavigation,
  findContextSource,
  revealContextSourceEvent,
} from "./excerpt-source.tsx"
import { SessionElicitation } from "./session-elicitation.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import "./activity-timeline.css"
import { ConversationMessages } from "./conversation-messages.tsx"

function containsMessageSource(
  entries: readonly ExecutionEntry[],
  messageId: string,
): boolean {
  return entries.some((entry) =>
    entry.kind === "user_input" || entry.kind === "agent_input"
      ? entry.inputId === messageId
      : entry.kind === "tool"
        ? entry.execution.itemId === messageId
        : entry.kind === "assistant" && entry.itemId === messageId,
  )
}

export function Transcript({
  children,
  emptyState,
  loading = false,
}: Readonly<{
  children?: ReactNode
  emptyState?: ReactNode
  loading?: boolean
}>) {
  const { t } = useTranslation()
  const view = useExecutionView()
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const historyRevision = useAppStore((state) =>
    sessionId === undefined
      ? 0
      : (state.sessionHistoryRevisions[sessionId] ?? 0),
  )
  const historyBefore = useAppStore((state) => state.historyBefore)
  const loadEarlierHistory = useAppStore((state) => state.loadEarlierHistory)
  const prefetchEarlierHistory = useAppStore(
    (state) => state.prefetchEarlierHistory,
  )
  const loadHistoryThrough = useAppStore((state) => state.loadHistoryThrough)
  const historyLoading = useAppStore((state) =>
    state.inFlightActions.has(`history:${state.selection.sessionId}`),
  )
  const hydrating = useAppStore(
    (state) => state.hydratingSessionId === state.selection.sessionId,
  )
  const threadId = useAppStore(selectCurrentThreadId)
  const scroll = usePinnedScroll(threadId, historyRevision)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [visibleInputs, setVisibleInputs] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const selectionRevision = useAppStore(
    (state) => state.sessionSelectionIntentRevision,
  )
  const loadingEarlier = useRef<
    | Readonly<{
        sessionId: string
        selectionRevision: number
        historyRevision: number
      }>
    | undefined
  >(undefined)
  const earlierAnchor = useRef<
    | Readonly<{
        request: object
        sessionId: string
        selectionRevision: number
        historyRevision: number
        before: number
        node: Element
        top: number
        height: number
      }>
    | undefined
  >(undefined)
  const previousScrollTop = useRef(0)
  const previousTouchY = useRef<number | undefined>(undefined)
  const [pendingSource, setPendingSource] = useState<
    | Readonly<{
        navigation: ContextSourceNavigation
        selectionRevision: number
        historyRevision: number
      }>
    | undefined
  >(undefined)
  const inputs = view.entries
    .filter(
      (entry) => entry.kind === "user_input" || entry.kind === "agent_input",
    )
    .filter((entry) => !entry.steered)
  const inputIds = inputs.map((entry) => entry.inputId).join("\0")
  useEffect(() => {
    const revealSource = (event: Event) => {
      const navigation = (event as CustomEvent<ContextSourceNavigation>).detail
      const source = navigation.source
      const state = useAppStore.getState()
      if (
        source.kind !== "message" ||
        source.sessionId !== state.selection.sessionId ||
        containsMessageSource(state.execution.entries, source.messageId)
      )
        return
      setPendingSource({
        navigation,
        selectionRevision: state.sessionSelectionIntentRevision,
        historyRevision: state.sessionHistoryRevisions[source.sessionId] ?? 0,
      })
    }
    window.addEventListener(revealContextSourceEvent, revealSource)
    return () =>
      window.removeEventListener(revealContextSourceEvent, revealSource)
  }, [])
  useEffect(() => {
    if (!pendingSource) return
    const { navigation } = pendingSource
    const source = navigation.source
    if (
      source.kind !== "message" ||
      source.sessionId !== sessionId ||
      pendingSource.selectionRevision !== selectionRevision ||
      pendingSource.historyRevision !== historyRevision
    ) {
      setPendingSource(undefined)
      return
    }
    if (containsMessageSource(view.entries, source.messageId)) {
      // The new TurnBlock must mount its disclosure listener before retrying.
      const frame = requestAnimationFrame(() => {
        const state = useAppStore.getState()
        if (
          state.selection.sessionId !== source.sessionId ||
          state.sessionSelectionIntentRevision !==
            pendingSource.selectionRevision ||
          (state.sessionHistoryRevisions[source.sessionId] ?? 0) !==
            pendingSource.historyRevision
        )
          return
        setPendingSource(undefined)
        const target = findContextSource(source)
        if (target) target.scrollIntoView(navigation.options)
        else
          window.dispatchEvent(
            new CustomEvent(revealContextSourceEvent, { detail: navigation }),
          )
      })
      return () => cancelAnimationFrame(frame)
    }
    if (!historyLoading && historyBefore !== undefined) {
      void loadHistoryThrough(source.messageId).then((found) => {
        const state = useAppStore.getState()
        if (
          !found &&
          !state.inFlightActions.has(`history:${source.sessionId}`) &&
          !containsMessageSource(state.execution.entries, source.messageId)
        )
          setPendingSource((current) =>
            current === pendingSource ? undefined : current,
          )
      })
    } else if (!historyLoading) {
      setPendingSource(undefined)
    }
  }, [
    pendingSource,
    sessionId,
    selectionRevision,
    historyRevision,
    view.entries,
    historyLoading,
    historyBefore,
    loadHistoryThrough,
  ])
  // A message counts as in view while its turn segment — from its own bubble
  // to the next bubble — intersects the viewport, like codex's rail. Only
  // those markers take the active color; there is no default selection.
  const updateVisibleInputs = useCallback(() => {
    const viewport = scroll.viewportRef.current
    if (!viewport) return
    const { top, bottom } = viewport.getBoundingClientRect()
    const tops = (inputIds === "" ? [] : inputIds.split("\0")).map(
      (inputId) => ({
        inputId,
        top: anchors.current.get(inputId)?.getBoundingClientRect().top,
      }),
    )
    const next = new Set<string>()
    tops.forEach((entry, index) => {
      if (entry.top === undefined) return
      const end = tops[index + 1]?.top ?? Number.POSITIVE_INFINITY
      if (entry.top < bottom && end > top) next.add(entry.inputId)
    })
    setVisibleInputs((previous) =>
      previous.size === next.size && [...next].every((id) => previous.has(id))
        ? previous
        : next,
    )
  }, [inputIds, scroll.viewportRef])
  const prefetchNearEarlierHistory = useCallback(() => {
    const viewport = scroll.viewportRef.current
    if (
      sessionId === undefined ||
      hydrating ||
      historyBefore === undefined ||
      !viewport ||
      viewport.clientHeight <= 0
    )
      return
    // One viewport of lead time hides a page read during ordinary scrolling.
    // This implementation boundary caches one page and never expands the DOM.
    if (
      viewport.scrollHeight <= viewport.clientHeight ||
      viewport.scrollTop <= viewport.clientHeight
    )
      void prefetchEarlierHistory()
  }, [
    sessionId,
    hydrating,
    historyBefore,
    prefetchEarlierHistory,
    scroll.viewportRef,
  ])
  const requestEarlierHistory = useCallback(
    (fillViewport = false) => {
      const viewport = scroll.viewportRef.current
      if (
        !viewport ||
        sessionId === undefined ||
        hydrating ||
        historyBefore === undefined ||
        loadingEarlier.current ||
        (!fillViewport && viewport.scrollTop > 48)
      ) {
        return
      }
      const request = { sessionId, selectionRevision, historyRevision }
      loadingEarlier.current = request
      void loadEarlierHistory({
        beforePrepend: () => {
          const state = useAppStore.getState()
          if (
            loadingEarlier.current !== request ||
            state.selection.sessionId !== sessionId ||
            state.sessionSelectionIntentRevision !== selectionRevision ||
            (state.sessionHistoryRevisions[sessionId] ?? 0) !== historyRevision
          )
            return
          const node = scroll.contentRef.current?.firstElementChild
          if (!node) return
          scroll.pauseFollowing()
          // Capture immediately before the store commits the prepend. Streaming
          // and user scrolling while the request was pending belong to this view.
          earlierAnchor.current = {
            request,
            sessionId,
            selectionRevision,
            historyRevision,
            before: historyBefore,
            node,
            top: node.getBoundingClientRect().top,
            height: viewport.scrollHeight,
          }
        },
      }).then((loaded) => {
        if (!loaded && earlierAnchor.current?.request === request)
          earlierAnchor.current = undefined
        if (loadingEarlier.current === request)
          loadingEarlier.current = undefined
      })
    },
    [
      sessionId,
      selectionRevision,
      historyRevision,
      hydrating,
      historyBefore,
      loadEarlierHistory,
      scroll.viewportRef,
      scroll.contentRef,
      scroll.pauseFollowing,
    ],
  )
  const updateScroll = () => {
    scroll.onScroll()
    updateVisibleInputs()
    prefetchNearEarlierHistory()
    const viewport = scroll.viewportRef.current
    if (!viewport) return
    const upward = viewport.scrollTop < previousScrollTop.current
    previousScrollTop.current = viewport.scrollTop
    if (upward) requestEarlierHistory()
  }
  useLayoutEffect(() => {
    const saved = earlierAnchor.current
    const viewport = scroll.viewportRef.current
    if (!saved || !viewport) return
    if (
      saved.sessionId !== sessionId ||
      saved.selectionRevision !== selectionRevision ||
      saved.historyRevision !== historyRevision
    ) {
      earlierAnchor.current = undefined
      return
    }
    if (historyBefore === saved.before) return
    earlierAnchor.current = undefined
    // Extending a turn across the page boundary can replace its first block.
    // The height captured at commit also preserves position in that case.
    viewport.scrollTop += scroll.contentRef.current?.contains(saved.node)
      ? saved.node.getBoundingClientRect().top - saved.top
      : viewport.scrollHeight - saved.height
    previousScrollTop.current = viewport.scrollTop
    scroll.onScroll()
  }, [
    historyBefore,
    sessionId,
    selectionRevision,
    historyRevision,
    scroll.contentRef,
    scroll.viewportRef,
    scroll.onScroll,
  ])
  useLayoutEffect(() => {
    if (
      loadingEarlier.current?.sessionId !== sessionId ||
      loadingEarlier.current?.selectionRevision !== selectionRevision ||
      loadingEarlier.current?.historyRevision !== historyRevision
    ) {
      loadingEarlier.current = undefined
      earlierAnchor.current = undefined
      previousScrollTop.current = scroll.viewportRef.current?.scrollTop ?? 0
      previousTouchY.current = undefined
    }
  }, [sessionId, selectionRevision, historyRevision, scroll.viewportRef])
  // Streaming text changes entries but does not move input anchors. Measure
  // those only when the set of visible input anchors changes or on scroll.
  useLayoutEffect(updateVisibleInputs, [updateVisibleInputs])
  useLayoutEffect(() => {
    const content = scroll.contentRef.current
    const viewport = scroll.viewportRef.current
    if (!content || !viewport) return
    const updateLayout = () => {
      updateVisibleInputs()
      prefetchNearEarlierHistory()
      if (
        viewport.clientHeight > 0 &&
        viewport.scrollHeight <= viewport.clientHeight
      )
        requestEarlierHistory(true)
    }
    updateLayout()
    const observer = new ResizeObserver(updateLayout)
    observer.observe(content)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [
    scroll.contentRef,
    scroll.viewportRef,
    updateVisibleInputs,
    prefetchNearEarlierHistory,
    requestEarlierHistory,
  ])
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    const dock = dockRef.current
    if (!surface || !dock) return
    const updateDockHeight = () => {
      surface.style.setProperty(
        "--conversation-dock-height",
        `${Math.ceil(dock.getBoundingClientRect().height)}px`,
      )
      scroll.onLayoutChange()
    }
    updateDockHeight()
    const observer = new ResizeObserver(updateDockHeight)
    observer.observe(dock)
    return () => {
      observer.disconnect()
      surface.style.removeProperty("--conversation-dock-height")
    }
  }, [scroll.onLayoutChange])

  return (
    <ConversationScrollContext.Provider value={scroll}>
      <div
        ref={surfaceRef}
        className="conversation-surface relative flex min-h-0 flex-1"
        data-empty={emptyState !== undefined || undefined}
      >
        {sessionId && !loading ? (
          <ConversationFind
            key={sessionId}
            sessionId={sessionId}
            contentRef={scroll.contentRef}
            onJump={scroll.jumpToFindMatch}
          />
        ) : null}
        <ScrollArea
          className={cn(
            "min-h-0 min-w-0 flex-1",
            emptyState !== undefined && "hidden",
          )}
          viewportClassName="conversation-transcript-viewport"
          viewportRef={scroll.viewportRef}
          onScroll={updateScroll}
          onWheel={(event) => {
            if (event.deltaY < 0) requestEarlierHistory()
          }}
          onTouchStart={(event) => {
            previousTouchY.current = event.touches[0]?.clientY
          }}
          onTouchMove={(event) => {
            const y = event.touches[0]?.clientY
            if (
              y !== undefined &&
              previousTouchY.current !== undefined &&
              y > previousTouchY.current
            )
              requestEarlierHistory()
            previousTouchY.current = y
          }}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              (event.target instanceof HTMLElement &&
                (event.target.isContentEditable ||
                  event.target.closest("input, textarea, select")))
            )
              return
            if (["ArrowUp", "PageUp", "Home"].includes(event.key))
              requestEarlierHistory()
          }}
        >
          <div
            ref={scroll.contentRef}
            className="conversation-content mx-auto flex w-full flex-col"
          >
            {loading ? (
              <p
                role="status"
                className="py-12 text-center text-sm text-muted-foreground"
              >
                {t("Loading conversation…")}
              </p>
            ) : view.entries.length === 0 && view.activeTurnId === undefined ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {t("Conversation will appear here")}
              </p>
            ) : (
              <ConversationMessages
                view={view}
                historyRevision={historyRevision}
                onInputRef={(inputId, node) => {
                  if (node) anchors.current.set(inputId, node)
                  else anchors.current.delete(inputId)
                }}
              />
            )}
          </div>
        </ScrollArea>
        {loading ? null : (
          <ConversationNavigation
            entries={view.entries}
            visibleInputs={visibleInputs}
            viewportRef={scroll.viewportRef}
            contentRef={scroll.contentRef}
            onJump={(inputId) => {
              const node = anchors.current.get(inputId)
              if (node) scroll.jumpToElement(node)
            }}
          />
        )}
        {
          <button
            type="button"
            aria-label={t("Jump to latest output")}
            onClick={scroll.jumpToBottom}
            data-visible={!scroll.atBottom}
            tabIndex={scroll.atBottom ? -1 : 0}
            aria-hidden={scroll.atBottom}
            className="conversation-jump"
          >
            <ArrowDown className="size-5" />
          </button>
        }
        {children === undefined ? null : (
          <div ref={dockRef} className="conversation-dock">
            {emptyState}
            <div className="max-h-[45vh] overflow-y-auto">
              {loading ? null : <SessionElicitation />}
            </div>
            {children}
          </div>
        )}
      </div>
    </ConversationScrollContext.Provider>
  )
}
