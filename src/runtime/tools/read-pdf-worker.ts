import { fileURLToPath } from "node:url"
import { parentPort, workerData } from "node:worker_threads"

export type PdfReadRequest = Readonly<{
  bytes: Uint8Array
  format: "native" | "text" | "image"
  pages?: string
}>

export type PdfReadResult =
  | Readonly<{
      ok: true
      totalPages: number
      pages: number[]
      text: string
      images: { page: number; bytes: Uint8Array }[]
    }>
  | Readonly<{ ok: false; code: string; message: string }>

// Grok's PDF reader uses 10 automatic / 20 selected pages, 150 DPI, and JPEG 85.
// These are processing safety boundaries, not provider/model quotas.
const AUTO_PAGE_SAFETY_LIMIT = 10
const SELECTED_PAGE_SAFETY_LIMIT = 20
// Limit the raster allocation to 32 MB per page, with a dimension bound for
// pathological aspect ratios, and limit accumulated data crossing the worker.
const PAGE_PIXEL_SAFETY_LIMIT = 8_000_000
const PAGE_DIMENSION_SAFETY_LIMIT = 8_192
const OUTPUT_SAFETY_BYTES = 50_000_000

async function readPdf(input: PdfReadRequest): Promise<PdfReadResult> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const packageUrl = import.meta.resolve("pdfjs-dist/package.json")
  const loading = getDocument({
    data: input.bytes,
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(
      new URL("./standard_fonts/", packageUrl),
    ),
    wasmUrl: fileURLToPath(new URL("./wasm/", packageUrl)),
    verbosity: 0,
  })
  try {
    const document = await loading.promise
    if (document.numPages === 0) throw new Error("PDF has no pages.")
    if (input.format === "native") {
      return {
        ok: true,
        totalPages: document.numPages,
        pages: [],
        text: "",
        images: [],
      }
    }
    const selected = selectPages(input.pages, document.numPages)
    if (!selected.ok) return selected
    const texts: string[] = []
    const images: { page: number; bytes: Uint8Array }[] = []
    let outputBytes = 0
    for (const number of selected.pages) {
      const page = await document.getPage(number)
      try {
        if (input.format === "text") {
          const content = await page.getTextContent()
          let text = ""
          for (const item of content.items) {
            if (!("str" in item)) continue
            text += item.str + (item.hasEOL ? "\n" : " ")
          }
          const body = `--- Page ${number} ---\n${text.trim()}`
          outputBytes += Buffer.byteLength(body)
          texts.push(body)
        } else {
          const { createCanvas } = await import("@napi-rs/canvas")
          const original = page.getViewport({ scale: 150 / 72 })
          const reduction = Math.min(
            1,
            Math.sqrt(
              PAGE_PIXEL_SAFETY_LIMIT / (original.width * original.height),
            ),
            PAGE_DIMENSION_SAFETY_LIMIT /
              Math.max(original.width, original.height),
          )
          const viewport = page.getViewport({ scale: (150 / 72) * reduction })
          const canvas = createCanvas(
            Math.max(1, Math.floor(viewport.width)),
            Math.max(1, Math.floor(viewport.height)),
          )
          // PDF.js's Node canvas implements the rendering subset of the DOM
          // canvas API; its declarations still require the browser interface.
          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            viewport,
          }).promise
          const bytes = await canvas.encode("jpeg", 85)
          outputBytes += bytes.byteLength
          images.push({ page: number, bytes })
        }
        if (outputBytes > OUTPUT_SAFETY_BYTES)
          throw new Error(
            "PDF output exceeded the 50 MB processing safety boundary. Select fewer pages.",
          )
      } finally {
        page.cleanup()
      }
    }
    return {
      ok: true,
      totalPages: document.numPages,
      pages: selected.pages,
      text: texts.join("\n\n"),
      images,
    }
  } finally {
    await loading.destroy()
  }
}

function selectPages(
  spec: string | undefined,
  total: number,
):
  | { ok: true; pages: number[] }
  | { ok: false; code: string; message: string } {
  const invalid = (message: string) => ({
    ok: false as const,
    code: "invalid_pdf_pages",
    message,
  })
  if (spec === undefined) {
    return total > AUTO_PAGE_SAFETY_LIMIT
      ? invalid(
          `PDF has ${total} pages, above the ${AUTO_PAGE_SAFETY_LIMIT}-page automatic processing safety boundary. Specify pages, e.g. "1-5" (up to ${SELECTED_PAGE_SAFETY_LIMIT} pages per read).`,
        )
      : {
          ok: true,
          pages: Array.from({ length: total }, (_, index) => index + 1),
        }
  }
  const pages = new Set<number>()
  for (const part of spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(part)
    if (match === null) return invalid(`Invalid PDF page range: ${part}.`)
    const start = Number(match[1])
    const requestedEnd =
      match[2] === undefined
        ? start
        : match[2] === ""
          ? total
          : Number(match[2])
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start < 1 ||
      start > total
    )
      return invalid(`Page ${start} is out of range; PDF has ${total} pages.`)
    if (requestedEnd < start)
      return invalid(
        `Invalid PDF page range: ${part}; start must not exceed end.`,
      )
    const end = Math.min(total, requestedEnd)
    // Check before enumerating a potentially huge range in an untrusted PDF.
    if (end - start + 1 > SELECTED_PAGE_SAFETY_LIMIT)
      return invalid(
        `Select at most ${SELECTED_PAGE_SAFETY_LIMIT} pages per read (processing safety boundary).`,
      )
    for (let page = start; page <= end; page += 1) pages.add(page)
    if (pages.size > SELECTED_PAGE_SAFETY_LIMIT)
      return invalid(
        `Select at most ${SELECTED_PAGE_SAFETY_LIMIT} pages per read (processing safety boundary).`,
      )
  }
  return pages.size === 0
    ? invalid("No PDF pages specified.")
    : { ok: true, pages: [...pages].sort((left, right) => left - right) }
}

if (parentPort !== null) {
  // Worker entrypoint is the operational boundary for untrusted PDF parsers.
  // The parent always terminates this worker, including timeout and abort.
  try {
    parentPort.postMessage(await readPdf(workerData as PdfReadRequest))
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code: "pdf_read_failed",
      message: `Unable to read PDF: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies PdfReadResult)
  }
}
