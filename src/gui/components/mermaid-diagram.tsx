import { useEffect, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { ImageLightbox } from "./image-lightbox.tsx"
import { CopyIconButton } from "./response-actions.tsx"

let renderQueue: Promise<unknown> = Promise.resolve()
let nextDiagramId = 0

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  })
  return () => observer.disconnect()
}

function currentTheme() {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

function renderDiagram(
  source: string,
  theme: "light" | "dark",
  signal: AbortSignal,
): Promise<string | undefined> {
  // initialize changes Mermaid's global configuration. Keep initialization and
  // the entire asynchronous render together, even across separate messages.
  const render = renderQueue.then(async () => {
    if (signal.aborted) return
    const { default: mermaid } = await import("mermaid")
    await document.fonts?.ready
    if (signal.aborted) return
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
      darkMode: theme === "dark",
      htmlLabels: false,
      fontFamily: getComputedStyle(document.body).fontFamily,
    })
    // Layout needs a connected, measurable element. Owning this container also
    // makes cleanup independent of Mermaid's temporary-element naming.
    const container = document.createElement("div")
    container.setAttribute("aria-hidden", "true")
    container.inert = true
    container.style.cssText =
      "position:absolute;top:0;left:0;width:100%;visibility:hidden;pointer-events:none"
    document.body.append(container)
    try {
      const { svg } = await mermaid.render(
        `yakitori-mermaid-${nextDiagramId++}`,
        source,
        container,
      )
      const diagram = new DOMParser().parseFromString(svg, "image/svg+xml")
      const element = diagram.documentElement
      // Keep the same contrast when the image opens over the dark lightbox.
      element.setAttribute(
        "style",
        `${element.getAttribute("style") ?? ""};background-color:${getComputedStyle(document.body).backgroundColor}`,
      )
      const viewBox = element
        .getAttribute("viewBox")
        ?.trim()
        .split(/\s+/)
        .map(Number)
      if (
        viewBox?.length === 4 &&
        viewBox.every(Number.isFinite) &&
        (viewBox[2] ?? 0) > 0 &&
        (viewBox[3] ?? 0) > 0
      ) {
        // Mermaid normally sizes an inline SVG to 100%. Give the standalone
        // image intrinsic dimensions; CSS can then shrink it proportionally.
        element.setAttribute("width", String(viewBox[2]))
        element.setAttribute("height", String(viewBox[3]))
      }
      // An image keeps SVG styles and content out of the surrounding app DOM.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(element))}`
    } finally {
      container.remove()
    }
  })
  // A rejected diagram must not block later diagrams; the caller still gets
  // that rejection and presents it alongside the original source.
  renderQueue = render.catch(() => {})
  return render
}

type DiagramResult = Readonly<{
  source: string
  theme: "light" | "dark"
  attempt: number
  image?: string
  error?: string
}>

export function MermaidDiagram({
  source,
  streaming,
}: Readonly<{ source: string; streaming: boolean }>) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme)
  const [showSource, setShowSource] = useState(false)
  const [expandedImage, setExpandedImage] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<DiagramResult>()
  const canRender = !streaming && source.trim().length > 0
  useEffect(() => {
    if (!canRender) return
    const controller = new AbortController()
    void renderDiagram(source, theme, controller.signal).then(
      (image) => {
        if (!controller.signal.aborted && image !== undefined)
          setResult({ source, theme, attempt, image })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            source,
            theme,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          })
      },
    )
    return () => controller.abort()
  }, [source, theme, attempt, canRender])

  const current =
    canRender &&
    result?.source === source &&
    result.theme === theme &&
    result.attempt === attempt
      ? result
      : undefined
  return (
    <div className="my-3 min-w-0 rounded-lg border border-border">
      <div
        data-find-ignore
        className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground"
      >
        <span className="mr-auto">Mermaid</span>
        {current?.image ? (
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={
              showSource ? "Show Mermaid diagram" : "Show Mermaid source"
            }
            onClick={() => setShowSource((show) => !show)}
          >
            {showSource ? "Diagram" : "Source"}
          </button>
        ) : null}
        <CopyIconButton text={source} label="Mermaid source" />
      </div>
      {canRender && current?.image === undefined ? (
        <div
          data-find-ignore
          className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground"
        >
          <span
            role="status"
            className="min-w-0 whitespace-pre-wrap break-words"
          >
            {current?.error === undefined
              ? "Rendering Mermaid diagram…"
              : `Could not render Mermaid diagram. ${current.error}`}
          </span>
          {current?.error === undefined ? null : (
            <button
              type="button"
              className="shrink-0 rounded px-2 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry diagram
            </button>
          )}
        </div>
      ) : null}
      {current?.image && !showSource ? (
        <div className="overflow-x-auto p-3">
          <button
            type="button"
            aria-label="Expand Mermaid diagram"
            className="block w-full cursor-zoom-in rounded focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setExpandedImage(current.image)}
          >
            <img
              src={current.image}
              alt="Mermaid diagram"
              className="mx-auto h-auto max-w-full"
              onError={() =>
                setResult({
                  source,
                  theme,
                  attempt,
                  error: "The rendered image could not be displayed.",
                })
              }
            />
          </button>
        </div>
      ) : (
        <pre className="m-0 overflow-x-auto rounded-none border-0 p-3">
          <code>{source}</code>
        </pre>
      )}
      {current?.image && expandedImage === current.image
        ? createPortal(
            <div data-find-ignore>
              <ImageLightbox
                src={current.image}
                name="Mermaid diagram"
                onClose={() => setExpandedImage(undefined)}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
