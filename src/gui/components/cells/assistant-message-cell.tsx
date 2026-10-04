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
    </div>
  )
}
