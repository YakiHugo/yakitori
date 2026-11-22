import { ChevronRight } from "lucide-react"
import { useId } from "react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { formatElapsed } from "../../lib/format.ts"
import { useThreadScopeState } from "../../store/thread-scope-store.ts"
import { useConversationScope } from "../conversation-scope.tsx"
import {
  encryptedReasoningLabel,
  ReasoningTrace,
  reasoningSections,
} from "../reasoning-trace.tsx"
import { TranscriptDisclosureContent } from "../transcript-disclosure.tsx"
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible.tsx"

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
  const { threadId } = useConversationScope()
  const [open, setOpen] = useThreadScopeState(
    threadId,
    `reasoning:${entry.itemId}`,
    false,
  )
  const contentId = useId()
  if (entry.representation === "redacted")
    return (
      <p className="py-1 text-detail text-muted-foreground">
        {encryptedReasoningLabel}
      </p>
    )
  if (!entry.incomplete && !entry.text.trim()) return null
  const summary = entry.representation === "summary"
  const streaming = entry.status === "streaming"
  const sections = summary ? reasoningSections(entry.text) : []
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
  const seconds = Math.floor((entry.durationMs ?? 0) / 1000)
  const label = summary
    ? streaming
      ? "Reasoning summary…"
      : "Reasoning summary"
    : streaming
      ? "Reasoning…"
      : seconds > 0
        ? `Thought for ${formatElapsed(seconds)}`
        : "Reasoning"
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
        <span>{label}</span>
        <ChevronRight className="size-3 transition-transform group-data-[state=open]/reasoning:rotate-90" />
      </CollapsibleTrigger>
      {!summary && streaming && !open && entry.text.trim() ? (
        <p className="line-clamp-2 max-w-prose break-words whitespace-pre-wrap text-detail text-muted-foreground opacity-80">
          {entry.text.length > 360 ? `…${entry.text.slice(-360)}` : entry.text}
        </p>
      ) : null}
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
