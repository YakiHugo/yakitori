import { createHash } from "node:crypto"
import type { ModelDocumentBlock, ModelImageBlock } from "../kernel/events.ts"
import type { RolloutAssets } from "../kernel/rollout-assets.ts"
import { prepareModelImage } from "./prepare-model-image.ts"
import { readPdf } from "./tools/read-pdf.ts"
import type { PdfReadResult } from "./tools/read-pdf-worker.ts"

export type DocumentReadingCapabilities = Readonly<{
  nativePdf: boolean
  images: boolean
}>

// Request projection replays history each step. Bound cached parser/raster
// results by both bytes and entries so repeated PDFs do not repeatedly spawn
// workers, while long-running sessions cannot retain unbounded media.
const CACHE_SAFETY_BYTES = 64 * 1024 * 1024
const CACHE_SAFETY_ENTRIES = 16
const cache = new Map<string, { result: PdfReadResult; size: number }>()

export async function prepareModelDocuments(
  documents: readonly ModelDocumentBlock[],
  assets: RolloutAssets | undefined,
  capabilities: DocumentReadingCapabilities,
  signal?: AbortSignal,
): Promise<{
  content: string
  images: ModelImageBlock[]
  documents: ModelDocumentBlock[]
}> {
  const projected = {
    content: "",
    images: [] as ModelImageBlock[],
    documents: [] as ModelDocumentBlock[],
  }
  for (const document of documents) {
    signal?.throwIfAborted()
    if (assets === undefined)
      throw new Error("Document asset storage unavailable.")
    const bytes = await assets.read(document.file)
    if (bytes.length !== document.sizeBytes)
      throw new Error("Document asset size mismatch.")
    if (capabilities.nativePdf) {
      projected.documents.push({ ...document, data: bytes.toString("base64") })
      continue
    }
    const format = capabilities.images ? "image" : "text"
    const key = `${format}:${createHash("sha256").update(bytes).digest("hex")}`
    let cached = cache.get(key)
    if (cached === undefined) {
      const result = await readPdf(
        { bytes: Uint8Array.from(bytes), format },
        signal,
      )
      const size = result.ok
        ? Buffer.byteLength(result.text) +
          result.images.reduce((sum, image) => sum + image.bytes.byteLength, 0)
        : Buffer.byteLength(result.message)
      cached = { result, size }
      if (
        size <= CACHE_SAFETY_BYTES &&
        (result.ok || result.code !== "pdf_read_timeout")
      ) {
        // Another turn may have populated this key while our worker ran.
        // Derive the retained size from the bounded map after replacement,
        // rather than maintaining a second counter that can drift.
        cache.delete(key)
        let cachedBytes = [...cache.values()].reduce(
          (sum, entry) => sum + entry.size,
          0,
        )
        while (
          cache.size >= CACHE_SAFETY_ENTRIES ||
          cachedBytes + size > CACHE_SAFETY_BYTES
        ) {
          const oldest = cache.entries().next().value
          if (oldest === undefined) break
          cache.delete(oldest[0])
          cachedBytes -= oldest[1].size
        }
        cache.set(key, cached)
      }
    } else {
      cache.delete(key)
      cache.set(key, cached)
    }
    const { result } = cached
    const source = assets.resolve(document.file)
    if (!result.ok) {
      projected.content += `\n\n[PDF ${document.name} was not read: ${result.message} Stored PDF: ${source}. Use read_document with ${JSON.stringify({ path: source, pages: "1-5", format })} to select pages or retry.]`
      continue
    }
    projected.content += `\n\nPDF ${document.name} (${result.totalPages} pages; stored at ${source}):`
    if (format === "text") {
      projected.content += `\n${result.text}`
    } else {
      projected.content += `\nRendered pages ${result.pages.join(", ")} are attached in page order.`
      projected.images.push(
        ...(await Promise.all(
          result.images.map((image) =>
            prepareModelImage(Buffer.from(image.bytes), "high"),
          ),
        )),
      )
    }
  }
  return projected
}
