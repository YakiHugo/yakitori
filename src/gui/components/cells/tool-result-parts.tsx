import { useState } from "react"
import type { ModelToolContentBlock } from "../../../protocol/conversation.ts"
import { openUrlTarget } from "../../lib/open-resource.ts"
import { rolloutAssetUrl } from "../../rollout-asset-url.ts"

export function ToolResultParts({
  parts,
  toolCallId,
  apiBase,
}: Readonly<{
  parts: readonly ModelToolContentBlock[]
  toolCallId: string
  apiBase: string
}>) {
  const [openError, setOpenError] = useState<string>()
  return (
    <section className="space-y-2" aria-label="Ordered tool result">
      {parts.map((part, index) => {
        // Completed items replace one stable tool entry. Part indices are stable
        // within that immutable payload, including repeated references to one file.
        const key = `${toolCallId}:${index}`
        if (part.type === "text")
          return (
            <pre
              key={key}
              className="font-mono text-xs leading-5 whitespace-pre-wrap break-words"
            >
              {part.text}
            </pre>
          )
        const url =
          part.file === undefined
            ? undefined
            : rolloutAssetUrl(part.file, apiBase)
        if (url === undefined)
          return (
            <p key={key} className="text-xs text-muted-foreground">
              {part.type === "document" ? "PDF" : "Image"} preview unavailable
            </p>
          )
        if (part.type === "document")
          return (
            <a
              key={key}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault()
                setOpenError(undefined)
                void openUrlTarget({ kind: "url", url }).catch(
                  (error: unknown) => {
                    setOpenError(
                      error instanceof Error
                        ? error.message
                        : "Could not open PDF",
                    )
                  },
                )
              }}
              className="block text-sm underline underline-offset-2"
            >
              Open PDF: {part.name}
            </a>
          )
        return (
          <img
            key={key}
            src={url}
            alt={
              ("name" in part ? part.name : undefined) ??
              (part.file && !("url" in part.file)
                ? part.file.path.split("/").at(-1)
                : undefined) ??
              "Tool image"
            }
            loading="lazy"
            className="max-h-96 max-w-full rounded object-contain"
          />
        )
      })}
      {openError === undefined ? null : (
        <p role="alert" className="text-xs text-destructive">
          {openError}
        </p>
      )}
    </section>
  )
}
