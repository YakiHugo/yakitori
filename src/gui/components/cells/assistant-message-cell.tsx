import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ExecutionEntry } from "../../execution-view.ts"
import { Badge } from "../ui/badge.tsx"

export function AssistantMessageCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "assistant" }>
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Mate</span>
        {entry.status === "streaming" && (
          <Badge variant="secondary">streaming</Badge>
        )}
      </div>
      <div className="markdown text-sm leading-6">
        <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
      </div>
    </div>
  )
}
