import { contextSourceAttributes } from "../../conversation-context.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import { CopyIconButton, MessageTimestamp } from "../response-actions.tsx"

export function AgentMessageCell({
  entry,
  sessionId,
}: Readonly<{
  entry: Extract<ExecutionEntry, { kind: "agent_input" }>
  sessionId?: string | undefined
}>) {
  const label =
    entry.sourceSessionId === undefined ? "Agent task" : "Agent message"
  return (
    <article
      aria-label={label}
      className="group flex flex-col items-end gap-1.5"
    >
      <div
        className="max-w-[85%] rounded-2xl border bg-muted/50 px-4 py-3"
        {...contextSourceAttributes(
          sessionId
            ? {
                kind: "message",
                label,
                sessionId,
                messageId: entry.inputId,
              }
            : undefined,
        )}
      >
        <p
          className="mb-1 text-caption text-muted-foreground"
          title={
            entry.sourceSessionId === undefined
              ? undefined
              : `From session ${entry.sourceSessionId}`
          }
        >
          {label}
        </p>
        <p className="whitespace-pre-wrap text-body break-words">
          {entry.text}
        </p>
      </div>
      <div className="message-actions opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <MessageTimestamp at={entry.at} />
        <CopyIconButton text={entry.text} label="agent message" />
      </div>
    </article>
  )
}
