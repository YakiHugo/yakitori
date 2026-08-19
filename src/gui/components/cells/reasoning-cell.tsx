import { ChevronRight } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ExecutionEntry } from "../../execution-view.ts"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.tsx"

export function ReasoningCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "reasoning" }>
}) {
  return (
    <Collapsible
      defaultOpen={entry.status === "streaming"}
      className="group/reasoning border-l border-foreground/15 pl-3"
    >
      <CollapsibleTrigger className="flex items-center gap-2 py-1 text-muted-foreground transition-colors hover:text-foreground">
        <span
          className={`size-1.5 rounded-full bg-current opacity-60 ${entry.status === "streaming" ? "animate-pulse" : ""}`}
        />
        <span className="font-mono text-[10px] tracking-[0.16em] uppercase">
          {entry.status === "streaming" ? "Reasoning…" : "Reasoning"}
        </span>
        <ChevronRight className="size-3 transition-transform group-data-[state=open]/reasoning:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 pb-2">
        <div className="markdown max-w-2xl text-sm leading-6 text-muted-foreground">
          <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
