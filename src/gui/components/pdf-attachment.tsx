import { useTranslation } from "../i18n/use-translation.ts"
import { useState } from "react"
import type { PdfAttachment } from "../../protocol/asset-types.ts"
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
  const { t } = useTranslation()
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
      setError(
        reason instanceof Error ? reason.message : t("Could not open PDF."),
      )
    })
  }
  return (
    <section
      aria-label={t("PDF attachment {0}", attachment.name)}
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
          {t("Open PDF")}
        </button>
        {downloadUrl === undefined ? (
          <span>{t("Download unavailable")}</span>
        ) : (
          <a
            className="underline underline-offset-2"
            href={downloadUrl.toString()}
            download={attachment.name}
          >
            {t("Download PDF")}
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
