import { Minus, Plus, X } from "lucide-react"
import { useEffect, useState } from "react"

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
  const [zoom, setZoom] = useState(1)
  const [fittedWidth, setFittedWidth] = useState<number>()
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
        className="grid min-h-0 flex-1 place-items-center overflow-auto px-10 pb-4"
      >
        <img
          src={src}
          alt={name}
          onLoad={(event) => {
            const image = event.currentTarget
            const box = image.parentElement?.getBoundingClientRect()
            if (!box || image.naturalWidth === 0) return
            setFittedWidth(
              Math.min(
                image.naturalWidth,
                (image.naturalWidth / image.naturalHeight) * box.height,
                box.width,
              ),
            )
          }}
          className="rounded-lg"
          style={
            fittedWidth === undefined
              ? { maxWidth: "100%", maxHeight: "100%" }
              : { width: fittedWidth * zoom }
          }
        />
      </div>
      <div data-backdrop className="flex justify-center pb-6">
        <div className="flex items-center gap-1 rounded-full bg-white/95 px-2 py-1.5 text-sm text-black shadow-lg">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= ZOOM_MIN}
            onClick={() =>
              setZoom((current) => Math.max(ZOOM_MIN, current - ZOOM_STEP))
            }
            className="grid size-8 place-items-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            title="Reset zoom"
            onClick={() => setZoom(1)}
            className="min-w-12 rounded-full px-1 py-1 text-center text-[13px] font-medium tabular-nums transition-colors hover:bg-black/10"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= ZOOM_MAX}
            onClick={() =>
              setZoom((current) => Math.min(ZOOM_MAX, current + ZOOM_STEP))
            }
            className="grid size-8 place-items-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
