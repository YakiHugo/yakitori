import type { ExecutionEntry } from "../../execution-view.ts"
import { MarkdownView } from "../markdown.tsx"

export function AssistantMessageCell({
  entry,
  workspaceRoot,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "assistant" }>
  readonly workspaceRoot?: string | undefined
}) {
  return (
    <MarkdownView
      text={entry.text}
      className="markdown text-[15px] leading-7"
      workspaceRoot={workspaceRoot}
    />
  )
}
