import { Worker } from "node:worker_threads"
import type { PdfReadRequest, PdfReadResult } from "./read-pdf-worker.ts"

// Matches Grok's PDF processing deadline. A separate worker lets the deadline
// and cancellation stop CPU-bound parsing instead of merely abandoning it.
const PDF_PROCESSING_SAFETY_MS = 60_000

export async function readPdf(
  input: PdfReadRequest,
  signal?: AbortSignal,
): Promise<PdfReadResult> {
  signal?.throwIfAborted()
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./read-pdf-worker.ts"
        : "./read-pdf-worker.js",
      import.meta.url,
    ),
    {
      workerData: input,
    },
  )
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<PdfReadResult>((resolve, reject) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            code: "pdf_read_timeout",
            message:
              "PDF processing exceeded the 60-second safety deadline. Select fewer pages.",
          }),
        PDF_PROCESSING_SAFETY_MS,
      )
      onAbort = () => reject(signal?.reason)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
      worker.once("message", (result: PdfReadResult) => resolve(result))
      worker.once("error", reject)
      worker.once("exit", (code) => {
        reject(
          new Error(
            `PDF worker exited before returning a result (code ${code}).`,
          ),
        )
      })
    })
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort)
    await worker.terminate()
  }
}
