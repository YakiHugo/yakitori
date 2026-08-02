import { ChevronRight } from "lucide-react"
import type { ExecutionEntry } from "../../execution-view.ts"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.tsx"

export function CompactionCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "context_compacted" }>
}) {
  return (
    <Collapsible className="rounded-md border border-dashed bg-muted/30">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/50">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Context compacted — earlier turns summarized
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2">
        <pre className="max-h-64 overflow-y-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
          {entry.summary}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
