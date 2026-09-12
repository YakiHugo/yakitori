import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ExecutionEntry } from "../../execution-view.ts"

export function AssistantMessageCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "assistant" }>
}) {
  return (
    <div className="markdown text-[15px] leading-7" data-assistant-message="">
      <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
    </div>
  )
}
