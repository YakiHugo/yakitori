import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  LoaderCircle,
  MessageSquare,
  Plus,
  RotateCw,
  X,
} from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type {
  WorkspaceBrowserSelection,
  WorkspaceBrowserState,
} from "../../desktop/workspace-browser-types.ts"
import { normalizeBrowserUrl } from "../../desktop/workspace-browser-url.ts"

export type BrowserPanelProps = Readonly<{
  tabId: string
  active: boolean
  initialUrl?: string
  onTitleChange?: (title: string) => void
  onSelection?: (input: Omit<WorkspaceBrowserSelection, "tabId">) => void
}>

export function BrowserPanel({
  tabId,
  active,
  initialUrl,
  onTitleChange,
  onSelection,
}: BrowserPanelProps) {
  const bridge = window.yakitoriDesktop?.browser
  const [state, setState] = useState<WorkspaceBrowserState>({
    tabId,
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  })
  const [address, setAddress] = useState(initialUrl ?? "")
  const [error, setError] = useState<string>()
  const [viewportError, setViewportError] = useState<string>()
  const [ready, setReady] = useState(false)
  const [preview, setPreview] = useState<string>()
  const viewport = useRef<HTMLDivElement>(null)
  const initial = useRef(initialUrl)
  const callbacks = useRef({ onTitleChange, onSelection })
  const observedUrl = useRef("")
  useLayoutEffect(() => {
    callbacks.current = { onTitleChange, onSelection }
  })

  useEffect(() => {
    if (!bridge) {
      if (initial.current) {
        try {
          const url = normalizeBrowserUrl(initial.current)
          setState((current) => ({ ...current, url }))
        } catch (failure) {
          setError(errorMessage(failure))
        }
      }
      return
    }
    let mounted = true
    function update(next: WorkspaceBrowserState) {
      if (!mounted || next.tabId !== tabId) return
      setState(next)
      if (observedUrl.current !== next.url) {
        observedUrl.current = next.url
        setAddress(next.url)
      }
      callbacks.current.onTitleChange?.(next.title || next.url || "Browser")
    }
    const unsubscribe = bridge.onState(update)
    const unselect = bridge.onSelection((selection) => {
      if (mounted && selection.tabId === tabId) {
        const { tabId: _tabId, ...input } = selection
        callbacks.current.onSelection?.(input)
      }
    })
    void bridge
      .create({
        tabId,
        ...(initial.current === undefined ? {} : { url: initial.current }),
      })
      .then((value) => {
        if (!mounted) return
        update(value)
        setReady(true)
      })
      .catch((failure: unknown) => {
        if (mounted) setError(errorMessage(failure))
      })
    return () => {
      mounted = false
      unsubscribe()
      unselect()
      void bridge
        .close({ tabId })
        .catch((failure: unknown) =>
          console.error("Browser tab cleanup failed", failure),
        )
    }
  }, [bridge, tabId])

  useLayoutEffect(() => {
    const element = viewport.current
    if (!bridge || !element || !ready) return
    let scheduled = false
    let disposed = false
    let previous = ""
    let revision = 0
    function update() {
      scheduled = false
      if (disposed) return
      if (!element) return
      const rect = element.getBoundingClientRect()
      // Only overlapping renderer controls need the native page to yield.
      const overlay = [
        ...document.querySelectorAll(
          'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper], .selection-actions, .annotation-editor, .context-excerpt-popover, .composer-control-popover, .composer-suggestion-panel',
        ),
      ].some((node) =>
        [...node.getClientRects()].some(
          (overlay) =>
            overlay.width > 0 &&
            overlay.height > 0 &&
            overlay.left < rect.right &&
            overlay.right > rect.left &&
            overlay.top < rect.bottom &&
            overlay.bottom > rect.top,
        ),
      )
      const input = {
        tabId,
        visible: active && !state.error && Boolean(state.url),
        occluded: overlay,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }
      const fingerprint = JSON.stringify(input)
      if (fingerprint === previous) return
      previous = fingerprint
      const request = ++revision
      void bridge
        ?.viewport(input)
        .then((image) => {
          if (request !== revision) return
          setPreview(image)
          setViewportError(undefined)
        })
        .catch((failure: unknown) => {
          if (request === revision) setViewportError(errorMessage(failure))
        })
    }
    function schedule() {
      // Native content can occlude the renderer and suspend animation frames.
      // Its visibility must still follow renderer popup/tab changes.
      if (scheduled) return
      scheduled = true
      queueMicrotask(update)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    const overlays = new MutationObserver(schedule)
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-state",
        "hidden",
        "aria-hidden",
        "open",
        "style",
        "class",
      ],
    })
    window.addEventListener("resize", schedule)
    window.addEventListener("scroll", schedule, true)
    document.addEventListener("visibilitychange", schedule)
    update()
    return () => {
      revision += 1
      disposed = true
      resize.disconnect()
      overlays.disconnect()
      window.removeEventListener("resize", schedule)
      window.removeEventListener("scroll", schedule, true)
      document.removeEventListener("visibilitychange", schedule)
      void bridge
        .viewport({ tabId, visible: false, x: 0, y: 0, width: 0, height: 0 })
        .catch((failure: unknown) =>
          console.error("Browser viewport cleanup failed", failure),
        )
    }
  }, [bridge, tabId, active, ready, state.error, state.url])

  async function perform(operation: () => Promise<void>) {
    setError(undefined)
    try {
      await operation()
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  function browserAction(action: "back" | "forward" | "reload" | "stop") {
    if (bridge) void perform(() => bridge.action({ tabId, action }))
  }
  function navigate() {
    if (!address.trim()) return
    if (bridge) {
      void perform(() => bridge.navigate({ tabId, url: address }))
    } else {
      try {
        const url = normalizeBrowserUrl(address)
        setState((current) => ({ ...current, url }))
        setError(undefined)
      } catch (failure) {
        setError(errorMessage(failure))
      }
    }
  }

  return (
    <section aria-label="Browser" className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex shrink-0 items-center gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault()
          navigate()
        }}
      >
        <button
          type="button"
          className="sidebar-icon"
          aria-label="Back"
          disabled={!bridge || !state.canGoBack}
          onClick={() => browserAction("back")}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="sidebar-icon"
          aria-label="Forward"
          disabled={!bridge || !state.canGoForward}
          onClick={() => browserAction("forward")}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="sidebar-icon"
          aria-label={state.loading ? "Stop loading" : "Reload page"}
          disabled={!bridge || !state.url}
          onClick={() => browserAction(state.loading ? "stop" : "reload")}
        >
          {state.loading ? <X size={14} /> : <RotateCw size={14} />}
        </button>
        <input
          aria-label="Browser address"
          className="h-8 min-w-0 flex-1 rounded-md border bg-muted/30 px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          placeholder="Enter a URL"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="submit"
          className="sidebar-icon"
          aria-label="Go to address"
          disabled={!address.trim()}
        >
          {state.loading ? (
            <LoaderCircle size={14} className="animate-spin" />
          ) : (
            <ArrowRight size={14} />
          )}
        </button>
      </form>
      {bridge && state.url && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[11px] text-muted-foreground">
          <span className="mr-auto truncate">
            Select page text to discuss it
          </span>
          <button
            type="button"
            title="Add selected text to conversation"
            aria-label="Add selected text to conversation"
            className="sidebar-icon"
            onClick={() =>
              void perform(() => bridge.selection({ tabId, action: "add" }))
            }
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            title="Ask about selected text in side chat"
            aria-label="Ask about selected text in side chat"
            className="sidebar-icon"
            onClick={() =>
              void perform(() => bridge.selection({ tabId, action: "chat" }))
            }
          >
            <MessageSquare size={14} />
          </button>
        </div>
      )}
      {(error || state.error || viewportError) && (
        <div
          role="status"
          className="shrink-0 border-b px-3 py-2 text-xs text-destructive"
        >
          {error || state.error || viewportError}
        </div>
      )}
      <div ref={viewport} className="relative min-h-0 flex-1">
        {preview && active && (
          <img
            src={preview}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-fill"
          />
        )}
        {!bridge ? (
          <div className="workspace-empty h-full">
            <Globe size={28} strokeWidth={1.25} />
            <strong>Open websites in the desktop app</strong>
            <p>
              The desktop app displays websites here. In this browser, open the
              page in a separate tab.
            </p>
            {state.url && (
              <a
                href={state.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-foreground"
              >
                <ExternalLink size={14} />
                Open page
              </a>
            )}
          </div>
        ) : !state.url && !state.loading ? (
          <div className="workspace-empty h-full">
            <Globe size={28} strokeWidth={1.25} />
            <strong>A page beside your conversation</strong>
            <p>
              Enter a website or local app URL above. Select text on a page to
              add context or ask a question.
            </p>
          </div>
        ) : state.error ? (
          <div className="workspace-empty h-full">
            <Globe size={28} strokeWidth={1.25} />
            <strong>This page could not be loaded</strong>
            <p>Check the address or reload the page to try again.</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
