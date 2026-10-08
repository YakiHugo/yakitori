import { Minus, Plus, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

const ZOOM_STEP = 0.25
const ZOOM_MIN = 0.25
const ZOOM_MAX = 5

// Codex-style attachment preview: dimmed backdrop, centered image, and a zoom
// pill. 100% fits the image into the viewport; +/- scales its laid-out size,
// so zoomed images can be panned by dragging the scroll area.
export function ImageLightbox({
  src,
  name,
  onClose,
}: Readonly<{
  src: string
  name: string
  onClose(): void
}>) {
  const [zoom, setZoom] = useState<number | "actual">(1)
  const [fittedWidth, setFittedWidth] = useState<number>()
  const [naturalWidth, setNaturalWidth] = useState<number>()
  const imageRef = useRef<HTMLImageElement>(null)
  const measure = useCallback(() => {
    const image = imageRef.current
    const viewport = image?.parentElement
    if (
      !image ||
      !viewport ||
      image.naturalWidth === 0 ||
      image.naturalHeight === 0
    )
      return
    const style = getComputedStyle(viewport)
    // client dimensions exclude borders/scrollbars but include padding.
    // Fit to the content box so the first view and reset show every edge.
    const width =
      viewport.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0)
    const height =
      viewport.clientHeight -
      (Number.parseFloat(style.paddingTop) || 0) -
      (Number.parseFloat(style.paddingBottom) || 0)
    if (width <= 0 || height <= 0) return
    setNaturalWidth(image.naturalWidth)
    setFittedWidth(
      Math.min(
        image.naturalWidth,
        (image.naturalWidth / image.naturalHeight) * height,
        width,
      ),
    )
  }, [])
  useEffect(() => {
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [measure])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [onClose])
  const zoomFactor =
    zoom === "actual"
      ? naturalWidth === undefined || fittedWidth === undefined
        ? 1
        : naturalWidth / fittedWidth
      : zoom
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Backdrop dismissal has no keyboard equivalent; Escape and the close button cover it.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${name}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/85"
      onClick={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.dataset.backdrop !== undefined
        )
          onClose()
      }}
    >
      <div data-backdrop className="flex justify-end p-4">
        <button
          type="button"
          aria-label="Close preview"
          onClick={onClose}
          className="grid size-10 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <X className="size-5" />
        </button>
      </div>
      <div
        data-backdrop
        className="grid min-h-0 flex-1 overflow-auto px-10 pb-4"
        style={{ placeItems: "safe center" }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={name}
          onLoad={measure}
          className="rounded-lg"
          style={
            fittedWidth === undefined
              ? { maxWidth: "100%", maxHeight: "100%" }
              : {
                  width: zoom === "actual" ? naturalWidth : fittedWidth * zoom,
                  maxWidth: "none",
                }
          }
        />
      </div>
      <div data-backdrop className="flex justify-center pb-6">
        <div className="flex items-center gap-1 rounded-full bg-white/95 px-2 py-1.5 text-sm text-black shadow-lg">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoomFactor <= ZOOM_MIN}
            onClick={() => setZoom(Math.max(ZOOM_MIN, zoomFactor - ZOOM_STEP))}
            className="grid size-8 place-items-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            title="Reset zoom"
            onClick={() => {
              measure()
              setZoom(1)
            }}
            className="min-w-12 rounded-full px-1 py-1 text-center text-[13px] font-medium tabular-nums transition-colors hover:bg-black/10"
          >
            {Math.round(zoomFactor * 100)}%
          </button>
          <button
            type="button"
            aria-label="Actual size"
            title="Actual size"
            disabled={naturalWidth === undefined || fittedWidth === undefined}
            onClick={() => setZoom("actual")}
            className="rounded-full px-2 py-1 text-[13px] font-medium transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            1:1
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoomFactor >= ZOOM_MAX}
            onClick={() => setZoom(Math.min(ZOOM_MAX, zoomFactor + ZOOM_STEP))}
            className="grid size-8 place-items-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
