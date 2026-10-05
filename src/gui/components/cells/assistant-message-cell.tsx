import { citationURL } from "../../citation-sources.ts"
import { openUrlTarget } from "../../lib/open-resource.ts"
import { useWorkspaceStore } from "../../store/workspace-store.ts"
import { contextSourceAttributes } from "../../conversation-context.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import { useAppStore } from "../../store/app-store.ts"
import { MarkdownView } from "../markdown.tsx"
import { LiveTextNotice } from "./live-text-notice.tsx"

export function AssistantMessageCell({
  entry,
  workspaceRoot,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "assistant" }>
  readonly workspaceRoot?: string | undefined
}) {
  const sessionId = useAppStore((state) => state.selection.sessionId)
  return (
    <div
      {...contextSourceAttributes({
        kind: "message",
        label: "Assistant message",
        messageId: entry.itemId,
        ...(sessionId ? { sessionId } : {}),
      })}
    >
      <LiveTextNotice entry={entry} />
      <MarkdownView
        text={entry.text}
        streaming={entry.status === "streaming"}
        className="markdown text-base"
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
