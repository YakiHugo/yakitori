import { ChevronRight } from "lucide-react"
import { useId, useState } from "react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { ReasoningTrace, reasoningSections } from "../reasoning-trace.tsx"
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible.tsx"
import { TranscriptDisclosureContent } from "../transcript-disclosure.tsx"

export function ReasoningCell({
  entry,
  workspaceRoot,
  apiBase,
}: Readonly<{
  entry: Extract<ExecutionEntry, { kind: "reasoning" }>
  workspaceRoot?: string | undefined
  apiBase?: string | undefined
}>) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  if (!entry.incomplete && !entry.text.trim()) return null
  const sections = reasoningSections(entry.text)
  if (
    !entry.incomplete &&
    sections.length > 0 &&
    sections.every((section) => !section.body.trim())
  )
    return (
      <div className="flex flex-col gap-1 text-detail text-muted-foreground">
        {sections.map((section) => (
          <p key={section.line}>{section.summary}</p>
        ))}
      </div>
    )
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/reasoning">
      <CollapsibleTrigger
        aria-controls={contentId}
        className="flex items-center gap-2 py-1 text-detail text-muted-foreground transition-colors hover:text-foreground"
      >
        <span>{entry.status === "streaming" ? "Reasoning…" : "Reasoning"}</span>
        <ChevronRight className="size-3 transition-transform group-data-[state=open]/reasoning:rotate-90" />
      </CollapsibleTrigger>
      <TranscriptDisclosureContent
        id={contentId}
        open={open}
        className="max-h-96 overflow-y-auto pt-1 pb-2"
      >
        <ReasoningTrace
          apiBase={apiBase}
          entries={[entry]}
          active={entry.status === "streaming"}
          workspaceRoot={workspaceRoot}
        />
      </TranscriptDisclosureContent>
    </Collapsible>
  )
}
