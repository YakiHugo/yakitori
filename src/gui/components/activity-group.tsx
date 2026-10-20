import { ChevronRight, LoaderCircle, Wrench } from "lucide-react"
import type { ReactNode } from "react"
import type { ExecutionEntry } from "../execution-view.ts"
import { cn } from "../lib/utils.ts"
import { useAppStore } from "../store/app-store.ts"
import { presentTool } from "../tool-presentation.ts"
import { reasoningSections } from "./reasoning-trace.tsx"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx"

export function ActivityGroup({
  entries,
  active,
  pendingApproval,
  expanded,
  onExpandedChange,
  children,
}: Readonly<{
  entries: readonly ExecutionEntry[]
  active: boolean
  pendingApproval?: boolean
  expanded: boolean | undefined
  onExpandedChange: (expanded: boolean) => void
  children: ReactNode
}>) {
  const workspaceRoot = useAppStore((state) => state.execution.workingDirectory)
  const tools = entries.filter((entry) => entry.kind === "tool")
  const failed = tools.some(
    (entry) => entry.state === "failed" || entry.state === "interrupted",
  )
  const approval =
    pendingApproval ||
    entries.some(
      (entry) => entry.kind === "permission" && entry.state !== "resolved",
    )
  const counts = new Map<string, number>()
  for (const tool of tools) {
    const verb = presentTool(tool, workspaceRoot).verb
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  const actions = [...counts]
    .map(([verb, count]) => (count === 1 ? verb : `${verb} ${count}`))
    .join(" · ")
  const progress = entries.findLast(
    (entry) =>
      entry.kind === "assistant" &&
      entry.purpose === "commentary" &&
      entry.text.trim(),
  )
  const heading = entries
    .flatMap((entry) =>
      entry.kind === "reasoning"
        ? reasoningSections(entry.text).flatMap((section) =>
            section.summary ? [section.summary] : [],
          )
        : [],
    )
    .at(-1)
  const title =
    progress?.kind === "assistant"
      ? (progress.text.trim().split("\n")[0] ?? "Activity")
      : (heading ?? (actions || "Activity"))
  const open = expanded ?? (active || failed || approval)
  return (
    <Collapsible
      open={open}
      onOpenChange={onExpandedChange}
      className="group/activity"
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full min-w-0 items-center gap-2 py-1 text-left text-sm text-muted-foreground hover:text-foreground",
          failed && "text-destructive",
        )}
      >
        {active ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
        ) : (
          <Wrench className="size-4 shrink-0" />
        )}
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
        {title === actions ? null : (
          <span className="shrink-0 text-xs">
            {tools.length} {tools.length === 1 ? "action" : "actions"}
          </span>
        )}
        {approval ? (
          <span className="shrink-0">Approval required</span>
        ) : failed ? (
          <span className="shrink-0">Tool failed</span>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/activity:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-l pl-4 pt-2 pb-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
