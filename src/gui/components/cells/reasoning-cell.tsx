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
  onExpandedChange,
}: Readonly<{
  entry: Extract<ExecutionEntry, { kind: "reasoning" }>
  workspaceRoot?: string | undefined
  apiBase?: string | undefined
  onExpandedChange?: (open: boolean) => void
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
      <div className="reasoning-trace text-detail text-muted-foreground">
        {sections.map((section) => (
          <p key={section.line} className="font-medium">
            {section.summary}
          </p>
        ))}
      </div>
    )
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onExpandedChange?.(next)
      }}
      className="group/reasoning"
    >
      <CollapsibleTrigger
        aria-controls={contentId}
        className="reasoning-trigger transition-colors hover:text-foreground"
      >
        <span>{entry.status === "streaming" ? "Reasoning…" : "Reasoning"}</span>
        <ChevronRight className="size-3 transition-transform group-data-[state=open]/reasoning:rotate-90" />
      </CollapsibleTrigger>
      <TranscriptDisclosureContent
        id={contentId}
        open={open}
        className="reasoning-content"
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
