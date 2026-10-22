import { citationURL } from "../../citation-sources.ts"
import { contextSourceAttributes } from "../../conversation-context.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import { openUrlTarget } from "../../lib/open-resource.ts"
import { useWorkspaceStore } from "../../store/workspace-store.ts"
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
        {...(className === undefined ? {} : { className })}
        text={entry.text}
        streaming={entry.status === "streaming"}
        workspaceRoot={workspaceRoot}
      />
      {entry.sources?.length ? (
        <section
          aria-label="Sources"
          className="mt-3 text-sm text-muted-foreground"
        >
          <div className="mb-1 font-medium">Sources</div>
          <ol className="flex flex-wrap gap-x-4 gap-y-1">
            {entry.sources.map((source) => {
              const url = citationURL(source.url)
              return (
                <li key={source.id}>
                  {url === undefined ? (
                    <span>{source.label}</span>
                  ) : (
                    <a
                      href={url}
                      className="break-words underline underline-offset-2"
                      onClick={(event) => {
                        event.preventDefault()
                        if (event.metaKey || event.ctrlKey)
                          void openUrlTarget({ kind: "url", url })
                        else useWorkspaceStore.getState().openBrowser(url)
                      }}
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
