import type { ExecutionEntry } from "../../execution-view.ts"
import { contextSourceAttributes } from "../../conversation-context.ts"
import { useAppStore } from "../../store/app-store.ts"
import { MarkdownView } from "../markdown.tsx"

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
      <MarkdownView
        text={entry.text}
        className="markdown text-[15px] leading-7"
        workspaceRoot={workspaceRoot}
      />
    </div>
  )
}
