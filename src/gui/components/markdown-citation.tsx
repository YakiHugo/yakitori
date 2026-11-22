import type { MouseEvent } from "react"
import { citationURL } from "../citation-sources.ts"
import type { InlineCitation } from "../lib/markdown-citations.ts"
import { openUrlTarget } from "../lib/open-resource.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

export function openCitationLink(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault()
  const url = citationURL(event.currentTarget.getAttribute("href"))
  if (url === undefined) return
  if (event.metaKey || event.ctrlKey) void openUrlTarget({ kind: "url", url })
  else useWorkspaceStore.getState().openBrowser(url)
}

export function MarkdownCitation({
  citation,
  listId,
}: Readonly<{ citation: InlineCitation; listId: string }>) {
  const { source, number, citedText } = citation
  const url = citationURL(source.url)
  const label = `Citation ${number}, ${source.label}`
  return (
    <sup className="markdown-citation">
      <Tooltip>
        <TooltipTrigger asChild>
          {url === undefined ? (
            <button
              type="button"
              aria-label={label}
              onClick={() =>
                document.getElementById(`${listId}-${number}`)?.focus()
              }
            >
              [{number}]
            </button>
          ) : (
            <a href={url} onClick={openCitationLink} aria-label={label}>
              [{number}]
            </a>
          )}
        </TooltipTrigger>
        <TooltipContent
          sideOffset={6}
          className="max-w-[min(22rem,calc(100vw-2rem))] text-left text-wrap"
        >
          <div className="break-words font-medium">{source.label}</div>
          {url || source.location ? (
            <div className="break-words opacity-75">
              {[
                url === undefined ? undefined : new URL(url).hostname,
                source.location,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : null}
          {citedText ? (
            <div className="mt-1.5 max-h-40 overflow-y-auto break-words whitespace-pre-wrap">
              {citedText}
            </div>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </sup>
  )
}
