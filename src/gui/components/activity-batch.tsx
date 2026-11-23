import { Brain, ChevronRight, LoaderCircle, Wrench } from "lucide-react"
import { useId, useState } from "react"
import {
  type ActivityBatchEntry,
  summarizeToolBatch,
} from "../conversation-activity.ts"
import { executionEntryKey } from "../execution-view.ts"
import { cn } from "../lib/utils.ts"
import { HostedToolCell } from "./cells/hosted-tool-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { ToolCell } from "./cells/tool-cell.tsx"
import { useConversationScope } from "./conversation-scope.tsx"
import { TranscriptDisclosureContent } from "./transcript-disclosure.tsx"
import { TranscriptPresenterSlot } from "./transcript-presenters.tsx"
import { Collapsible, CollapsibleTrigger } from "./ui/collapsible.tsx"

export function ActivityBatch({
  entries,
}: Readonly<{
  entries: readonly [ActivityBatchEntry, ...ActivityBatchEntry[]]
}>) {
  const { workspaceRoot, apiBase } = useConversationScope()
  const [expanded, setExpanded] = useState<boolean>()
  const contentId = useId()
  const tools = entries.filter((entry) => entry.kind === "tool")
  const hosted = entries.filter((entry) => entry.kind === "hosted_tool")
  const streamingReasoning = entries.some(
    (entry) => entry.kind === "reasoning" && entry.status === "streaming",
  )
  const active =
    streamingReasoning ||
    tools.some((entry) => entry.state === "requested") ||
    hosted.some(({ tool }) => tool.status === "running")
  const failed =
    tools.some(
      (entry) => entry.state === "failed" || entry.resultError === true,
    ) || hosted.some(({ tool }) => tool.status === "failed")
  const interrupted =
    tools.some((entry) => entry.state === "interrupted") ||
    hosted.some(({ tool }) => tool.status === "interrupted")
  const hasProblem = failed || interrupted
  const grouped = entries.length > 1
  const streamingRaw = entries.some(
    (entry) =>
      entry.kind === "reasoning" &&
      entry.status === "streaming" &&
      (entry.format === undefined || entry.format === "raw"),
  )
  const open = !grouped || (expanded ?? streamingRaw)
  const summary =
    [
      tools.length > 0 ? summarizeToolBatch(tools) : undefined,
      hosted.length > 0
        ? `${hosted.length} hosted ${hosted.length === 1 ? "call" : "calls"}`
        : undefined,
    ]
      .filter(Boolean)
      .join(", ") || "Reasoning"
  const Icon = active
    ? LoaderCircle
    : tools.length + hosted.length > 0
      ? Wrench
      : Brain

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
          {entries.map((entry) => (
            <TranscriptPresenterSlot
              key={executionEntryKey(entry)}
              name="entry"
              context={{ entry }}
              fallback={
                entry.kind === "reasoning" ? (
                  <ReasoningCell
                    entry={entry}
                    workspaceRoot={workspaceRoot}
                    apiBase={apiBase}
                    onExpandedChange={(next) => {
                      if (next) setExpanded(true)
                    }}
                  />
                ) : entry.kind === "hosted_tool" ? (
                  <HostedToolCell entry={entry} />
                ) : (
                  <ToolCell
                    entry={entry}
                    workspaceRoot={workspaceRoot}
                    apiBase={apiBase}
                    separateMedia
                    onExpandedChange={(next) => {
                      if (next) setExpanded(true)
                    }}
                  />
                )
              }
            />
          ))}
        </section>
      </TranscriptDisclosureContent>
    </Collapsible>
  )
}
