import { useId } from "react"
import { citationURL } from "../../citation-sources.ts"
import { contextSourceAttributes } from "../../conversation-context.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import { cn } from "../../lib/utils.ts"
import { openCitationLink } from "../markdown-citation.tsx"
import { MarkdownView } from "../markdown.tsx"
import { LiveTextNotice } from "./live-text-notice.tsx"

export function AssistantMessageCell({
  entry,
  workspaceRoot,
  sessionId,
  apiBase,
  className,
  sourceLabel = "Assistant message",
}: Readonly<{
  entry: Extract<ExecutionEntry, { kind: "assistant" }>
  workspaceRoot?: string | undefined
  sessionId: string | undefined
  apiBase: string
  className?: string
  sourceLabel?: string
}>) {
  const citationListId = useId()
  return (
    <div
      {...contextSourceAttributes(
        sessionId
          ? {
              kind: "message",
              label: sourceLabel,
              messageId: entry.itemId,
              sessionId,
            }
          : undefined,
      )}
    >
      <LiveTextNotice entry={entry} />
      <MarkdownView
        apiBase={apiBase}
        className={cn(
          className,
          entry.purpose === "commentary" && "assistant-commentary",
        )}
        text={entry.text}
        streaming={entry.status === "streaming"}
        workspaceRoot={workspaceRoot}
        sources={entry.sources}
        citationListId={citationListId}
      />
      {entry.sources?.length ? (
        <section
          aria-label="Sources"
          className="mt-3 text-caption text-muted-foreground"
        >
          <div className="mb-1 font-medium">Sources</div>
          <ol className="flex flex-wrap gap-x-4 gap-y-1">
            {entry.sources.map((source, index) => {
              const url = citationURL(source.url)
              return (
                <li
                  key={source.id}
                  id={`${citationListId}-${index + 1}`}
                  tabIndex={-1}
                  className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {url === undefined ? (
                    <span>{source.label}</span>
                  ) : (
                    <a
                      href={url}
                      className="break-words underline underline-offset-2"
                      onClick={openCitationLink}
                    >
                      {source.label}
                    </a>
                  )}
                  {source.location ? <span> · {source.location}</span> : null}
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}
    </div>
  )
}
