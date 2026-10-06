import { useState } from "react"
import type { PdfAttachment } from "../../kernel/events.ts"
import { openUrlTarget } from "../lib/open-resource.ts"
import { rolloutAssetUrl } from "../rollout-asset-url.ts"

export async function openPdfAttachment(
  attachment: PdfAttachment,
  apiBase: string,
): Promise<void> {
  const url = rolloutAssetUrl(attachment.file, apiBase)
  if (url === undefined) throw new Error("PDF asset reference is invalid.")
  await openUrlTarget({ kind: "url", url })
}

export function PdfAttachmentCard({
  attachment,
  apiBase,
}: Readonly<{ attachment: PdfAttachment; apiBase: string }>) {
  const [error, setError] = useState<string>()
  const url = rolloutAssetUrl(attachment.file, apiBase)
  const downloadUrl = url === undefined ? undefined : new URL(url)
  downloadUrl?.searchParams.set("download", attachment.name)
  const activate = () => {
    setError(undefined)
    if (url === undefined) {
      setError("PDF asset reference is invalid.")
      return
    }
    void openUrlTarget({ kind: "url", url }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not open PDF.")
    })
  }
  return (
    <section
      aria-label={`PDF attachment ${attachment.name}`}
      className="rounded-lg border p-3 text-sm"
    >
      <p className="break-words font-medium">{attachment.name}</p>
      <p className="text-xs text-muted-foreground">
        PDF · {new Intl.NumberFormat().format(attachment.sizeBytes)} bytes
      </p>
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={activate}
        >
          Open PDF
        </button>
        {downloadUrl === undefined ? (
          <span>Download unavailable</span>
        ) : (
          <a
            className="underline underline-offset-2"
            href={downloadUrl.toString()}
            download={attachment.name}
          >
            Download PDF
          </a>
        )}
      </div>
      {error === undefined ? null : (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
