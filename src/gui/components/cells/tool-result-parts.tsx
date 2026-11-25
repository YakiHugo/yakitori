import { useState } from "react"
import type { ModelToolContentBlock } from "../../../protocol/conversation.ts"
import { openUrlTarget } from "../../lib/open-resource.ts"
import { rolloutAssetUrl } from "../../rollout-asset-url.ts"
import { ImageOutputCell } from "./image-output-cell.tsx"

export function ToolResultParts({
  parts,
  toolCallId,
  apiBase,
  label = "Ordered tool result",
}: Readonly<{
  parts: readonly ModelToolContentBlock[]
  toolCallId: string
  apiBase: string
  label?: string
}>) {
  const [openError, setOpenError] = useState<string>()
  return (
    <section className="space-y-2" aria-label={label}>
      {parts.map((part, index) => {
        // Completed items replace one stable tool entry. Part indices are stable
        // within that immutable payload, including repeated references to one file.
        const key = `${toolCallId}:${index}`
        if (part.type === "text")
          return (
            <pre key={key} className="tool-output max-h-96">
              {part.text}
            </pre>
          )
        if (part.type === "image")
          return (
            <ImageOutputCell
              key={key}
              image={part}
              apiBase={apiBase}
              label={
                part.file && !("url" in part.file)
                  ? (part.file.path.split("/").at(-1) ?? "Tool image")
                  : "Tool image"
              }
            />
          )
        const url = rolloutAssetUrl(part.file, apiBase)
        if (url === undefined)
          return (
            <p key={key} className="text-caption text-muted-foreground">
              PDF preview unavailable
            </p>
          )
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
            className="block text-caption underline underline-offset-2"
          >
            Open PDF: {part.name}
          </a>
        )
      })}
      {openError === undefined ? null : (
        <p role="alert" className="text-caption text-destructive">
          {openError}
        </p>
      )}
    </section>
  )
}
