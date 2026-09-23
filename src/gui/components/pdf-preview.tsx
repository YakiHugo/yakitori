import { ChevronLeft, ChevronRight } from "lucide-react"
import type { PDFDocumentProxy } from "pdfjs-dist"
import { useEffect, useRef, useState } from "react"

export function PdfPreview({ base64 }: Readonly<{ base64: string }>) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let current = true
    let loading: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined
    setDocument(undefined)
    setPage(1)
    setError(undefined)
    void (async () => {
      const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ])
      GlobalWorkerOptions.workerSrc = worker.default
      const decoded = atob(base64)
      const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0))
      if (!current) return
      loading = getDocument({ data: bytes })
      const loaded = await loading.promise
      if (current) setDocument(loaded)
    })().catch((cause: unknown) => {
      if (current)
        setError(cause instanceof Error ? cause.message : "Could not open PDF.")
    })
    return () => {
      current = false
      if (loading) void loading.destroy()
    }
  }, [base64])

  useEffect(() => {
    if (!document || !canvas.current) return
    let current = true
    setError(undefined)
    const surface = canvas.current
    surface.getContext("2d")?.clearRect(0, 0, surface.width, surface.height)
    let render:
      | ReturnType<Awaited<ReturnType<typeof document.getPage>>["render"]>
      | undefined
    void (async () => {
      const pdfPage = await document.getPage(page)
      if (!current || !canvas.current) return
      const viewport = pdfPage.getViewport({ scale: 1.4 })
      // Bound the canvas allocation for unusually large PDF page dimensions.
      const scale = Math.min(
        1,
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        8_192 / Math.max(viewport.width, viewport.height),
      )
      const sized = pdfPage.getViewport({ scale: 1.4 * scale })
      const canvasElement = canvas.current
      canvasElement.width = Math.ceil(sized.width)
      canvasElement.height = Math.ceil(sized.height)
      render = pdfPage.render({ canvas: canvasElement, viewport: sized })
      await render.promise
    })().catch((cause: unknown) => {
      if (
        current &&
        !(
          cause instanceof Error && cause.name === "RenderingCancelledException"
        )
      )
        setError(
          cause instanceof Error ? cause.message : "Could not render PDF page.",
        )
    })
    return () => {
      current = false
      render?.cancel()
    }
  }, [document, page])

  return (
    <div className="file-preview-pdf">
      {error ? (
        <p role="alert" className="px-4 py-3 text-destructive">
          {error}
        </p>
      ) : null}
      {document ? (
        <div className="file-preview-pdf-controls">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            Page {page} of {document.numPages}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={page === document.numPages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      ) : !error ? (
        <p role="status" className="px-4 py-3 text-muted-foreground">
          Loading PDF…
        </p>
      ) : null}
      <canvas ref={canvas} aria-label={`PDF page ${page}`} />
    </div>
  )
}
