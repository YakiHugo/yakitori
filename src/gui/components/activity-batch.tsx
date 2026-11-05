import { Brain, ChevronRight, LoaderCircle, Wrench } from "lucide-react"
import { useId, useState } from "react"
import {
  type ActivityBatchEntry,
  summarizeToolBatch,
} from "../conversation-activity.ts"
import { executionEntryKey } from "../execution-view.ts"
import { cn } from "../lib/utils.ts"
import { useAppStore } from "../store/app-store.ts"
import { ToolCell } from "./cells/tool-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { TranscriptDisclosureContent } from "./transcript-disclosure.tsx"
import { Collapsible, CollapsibleTrigger } from "./ui/collapsible.tsx"

export function ActivityBatch({
  entries,
}: Readonly<{
  entries: readonly [ActivityBatchEntry, ...ActivityBatchEntry[]]
}>) {
  const workspaceRoot = useAppStore((state) => state.execution.workingDirectory)
  const [expanded, setExpanded] = useState<boolean>()
  const contentId = useId()
  const tools = entries.filter((entry) => entry.kind === "tool")
  const active = entries.some((entry) =>
    entry.kind === "reasoning"
      ? entry.status === "streaming"
      : entry.state === "requested",
  )
  const failed = tools.some(
    (entry) => entry.state === "failed" || entry.resultError === true,
  )
  const interrupted = tools.some((entry) => entry.state === "interrupted")
  const hasProblem = failed || interrupted
  const grouped = entries.length > 1
  const open = !grouped || expanded === true
  const summary = tools.length > 0 ? summarizeToolBatch(tools) : "Reasoning"
  const Icon = active ? LoaderCircle : tools.length > 0 ? Wrench : Brain

  return (
    <Collapsible
      open={open}
      onOpenChange={setExpanded}
      className="activity-batch group/activity-batch"
      data-grouped={grouped}
    >
      {grouped ? (
        <CollapsibleTrigger
          aria-controls={contentId}
          className={cn(
            "activity-batch-trigger text-muted-foreground hover:text-foreground",
            hasProblem && "text-destructive hover:text-destructive",
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-4 shrink-0", active && "animate-spin")}
          />
          <span
            className={cn("min-w-0 truncate", active && "tool-running-label")}
          >
            {summary}
          </span>
          {hasProblem ? (
            <span className="shrink-0 text-caption">
              {failed ? "Failed" : "Interrupted"}
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]/activity-batch:rotate-90"
          />
        </CollapsibleTrigger>
      ) : null}
      <TranscriptDisclosureContent
        id={contentId}
        open={open}
        className="activity-batch-content"
      >
        <section
          className="activity-batch-viewport"
          aria-label={grouped ? "Activity details" : undefined}
          tabIndex={grouped ? 0 : undefined}
        >
          {entries.map((entry) =>
            entry.kind === "reasoning" ? (
              <ReasoningCell
                key={executionEntryKey(entry)}
                entry={entry}
                workspaceRoot={workspaceRoot}
                onExpandedChange={(next) => {
                  if (next) setExpanded(true)
                }}
              />
            ) : (
              <ToolCell
                key={executionEntryKey(entry)}
                entry={entry}
                workspaceRoot={workspaceRoot}
                onExpandedChange={(next) => {
                  if (next) setExpanded(true)
                }}
              />
            ),
          )}
        </section>
      </TranscriptDisclosureContent>
    </Collapsible>
  )
}
