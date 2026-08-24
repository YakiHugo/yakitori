import { ChevronRight, ExternalLink } from "lucide-react"
import { useEffect, useState } from "react"
import type { ExecutionEntry } from "../../execution-view.ts"
import {
  fileActionLabel,
  openFileTarget,
  openUrlTarget,
} from "../../lib/open-resource.ts"
import { cn } from "../../lib/utils.ts"
import { presentTool, type ToolTarget } from "../../tool-presentation.ts"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.tsx"
import { ToolDetailView } from "./tool-detail.tsx"

type ToolEntry = Extract<ExecutionEntry, { readonly kind: "tool" }>

export function ToolCell({
  entry,
  workspaceRoot,
  onOpenSession,
}: {
  readonly entry: ToolEntry
  readonly workspaceRoot?: string | undefined
  readonly onOpenSession?: ((sessionId: string) => Promise<void>) | undefined
}) {
  const presentation = presentTool(entry, workspaceRoot)
  const [open, setOpen] = useState(
    entry.state === "failed" || entry.state === "interrupted",
  )
  const active = entry.state === "requested"
  const failure = failureSummary(entry)

  useEffect(() => {
    if (entry.state === "failed" || entry.state === "interrupted") {
      setOpen(true)
    }
  }, [entry.state])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/tool">
      <div className="flex min-w-0 items-center rounded-md transition-colors hover:bg-muted/35">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left text-sm outline-none focus-visible:bg-muted/55">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/55 transition-transform group-data-[state=open]/tool:rotate-90" />
          <span
            className={cn(
              "shrink-0 font-medium",
              active && "tool-running-label",
              entry.state === "failed" && "text-destructive",
              entry.state === "interrupted" && "text-muted-foreground",
            )}
          >
            {active ? presentation.activeVerb : presentation.verb}
          </span>
          {presentation.subject !== "" ? (
            <span
              className={cn(
                "min-w-0 truncate text-foreground/85",
                presentation.subjectTone === "code" &&
                  "font-mono text-[0.8125rem]",
              )}
            >
              {presentation.subject}
            </span>
          ) : null}
          <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            {presentation.meta.map((part) => (
              <span key={part}>{part}</span>
            ))}
            {failure === undefined ? null : (
              <span
                className={cn(
                  entry.state === "failed"
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {failure}
              </span>
            )}
          </span>
        </CollapsibleTrigger>
        {presentation.target === undefined ? null : (
          <ResourceAction
            target={presentation.target}
            workspaceRoot={workspaceRoot}
            onOpenSession={onOpenSession}
          />
        )}
      </div>
      <CollapsibleContent className="ml-5 pt-1 pb-2 pl-2">
        <div className="rounded-md bg-muted/35 px-3 py-2.5">
          <ToolDetailView
            detail={presentation.detail}
            workspaceRoot={workspaceRoot}
            onOpenSession={onOpenSession}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ResourceAction({
  target,
  workspaceRoot,
  onOpenSession,
}: {
  readonly target: ToolTarget
  readonly workspaceRoot?: string | undefined
  readonly onOpenSession?: ((sessionId: string) => Promise<void>) | undefined
}) {
  const [error, setError] = useState<string>()
  const label =
    target.kind === "file"
      ? fileActionLabel()
      : target.kind === "url"
        ? "Open in browser"
        : "Open child task"
  return (
    <button
      type="button"
      aria-label={error ?? label}
      title={error ?? label}
      className={cn(
        "mr-1.5 rounded-sm p-1 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:bg-muted focus-visible:opacity-100 group-hover/tool:opacity-100",
        error !== undefined && "text-destructive opacity-100",
      )}
      onClick={() => {
        const action =
          target.kind === "file"
            ? openFileTarget(target, workspaceRoot)
            : target.kind === "url"
              ? openUrlTarget(target)
              : onOpenSession?.(target.sessionId)
        if (action === undefined) {
          setError("Child task is not available")
          return
        }
        void action.catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : "Could not open")
        })
      }}
    >
      <ExternalLink className="size-3.5" />
    </button>
  )
}

function failureSummary(entry: ToolEntry): string | undefined {
  if (entry.state === "interrupted") return "Interrupted"
  if (entry.state !== "failed") return undefined
  const message = entry.resultErrorMessage ?? "Failed"
  return message.length <= 72 ? message : `${message.slice(0, 71)}…`
}
