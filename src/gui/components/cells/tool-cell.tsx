import { ArrowUpRight, ChevronRight, ExternalLink } from "lucide-react"
import { useEffect, useState } from "react"
import {
  parseSessionPlan,
  parseUserQuestions,
} from "../../../kernel/user-interaction.ts"
import { imageAttachmentUrl } from "../../composer-attachments.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import {
  fileActionLabel,
  openFileTarget,
  openUrlTarget,
} from "../../lib/open-resource.ts"
import { cn } from "../../lib/utils.ts"
import { useAppStore } from "../../store/app-store.ts"
import { presentTool, type ToolTarget } from "../../tool-presentation.ts"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.tsx"
import { PlanCell, UserQuestionsCell } from "./session-progress-cell.tsx"
import { ToolDetailView } from "./tool-detail.tsx"
import "../activity-timeline.css"

type ToolEntry = Extract<ExecutionEntry, { readonly kind: "tool" }>

export function ToolCell({
  entry,
  workspaceRoot,
  onOpenSession,
  apiBase: apiBaseOverride,
}: Readonly<{
  entry: ToolEntry
  workspaceRoot?: string | undefined
  onOpenSession?: ((sessionId: string) => Promise<void>) | undefined
  apiBase?: string | undefined
}>) {
  const storeApiBase = useAppStore((state) => state.apiBase)
  const apiBase = apiBaseOverride ?? storeApiBase
  const presentation = presentTool(entry, workspaceRoot)
  const collaboration =
    presentation.detail?.kind === "collaboration"
      ? presentation.detail
      : undefined
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

  if (!entry.resultError && entry.output !== undefined) {
    if (entry.execution.name === "request_user_input_async") {
      const request = parseUserQuestions(entry.output)
      if (request)
        return (
          <UserQuestionsCell
            key={entry.toolCallId}
            request={request}
            toolCallId={entry.toolCallId}
          />
        )
    }
    if (entry.execution.name === "update_plan") {
      const plan = parseSessionPlan(entry.output)
      if (plan) return <PlanCell plan={plan} />
    }
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group/tool",
        collaboration !== undefined && "agent-collaboration",
      )}
    >
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
          {collaboration !== undefined && presentation.subject !== "" ? (
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
          ) : null}
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
          <span className="ml-auto hidden min-w-0 max-w-[40%] shrink-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground sm:flex">
            {(collaboration === undefined ? presentation.meta : []).map(
              (part) => (
                <span key={part} className="truncate">
                  {part}
                </span>
              ),
            )}
            {failure === undefined ? null : (
              <span
                className={cn(
                  "truncate",
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
        {presentation.target === undefined ||
        (collaboration !== undefined && onOpenSession === undefined) ? null : (
          <ResourceAction
            target={presentation.target}
            recipient={collaboration?.receivers[0]?.path}
            compact={collaboration !== undefined}
            workspaceRoot={workspaceRoot}
            onOpenSession={onOpenSession}
          />
        )}
      </div>
      {collaboration === undefined ||
      collaboration.receivers.length < 2 ? null : (
        <div className="agent-collaboration-recipients">
          {collaboration.receivers.map((receiver) => (
            <div
              key={receiver.sessionId}
              className="agent-collaboration-recipient"
            >
              {onOpenSession === undefined ? (
                <span
                  className="truncate text-muted-foreground"
                  title={receiver.path}
                >
                  {receiver.path}
                </span>
              ) : (
                <ResourceAction
                  target={{ kind: "session", sessionId: receiver.sessionId }}
                  recipient={receiver.path}
                  onOpenSession={onOpenSession}
                />
              )}
            </div>
          ))}
        </div>
      )}
      <CollapsibleContent className="pt-1 pb-2">
        <div className="rounded-md bg-muted/35 px-3 py-2.5">
          {(entry.attachments ?? []).map((attachment) => (
            <img
              key={`${attachment.file.rolloutId}:${attachment.file.path}`}
              src={imageAttachmentUrl(attachment, apiBase)}
              alt={attachment.name}
              loading="lazy"
              className="mb-2 max-h-96 max-w-full rounded object-contain"
            />
          ))}
          {collaboration?.request === undefined ? null : (
            <p className="mb-3 text-xs leading-5 whitespace-pre-wrap text-foreground/85">
              {collaboration.request}
            </p>
          )}
          <ToolDetailView
            detail={presentation.detail}
            workspaceRoot={workspaceRoot}
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
  recipient,
  compact = false,
}: Readonly<{
  target: ToolTarget
  workspaceRoot?: string | undefined
  onOpenSession?: ((sessionId: string) => Promise<void>) | undefined
  recipient?: string | undefined
  compact?: boolean
}>) {
  const [error, setError] = useState<string>()
  const label =
    target.kind === "file"
      ? fileActionLabel()
      : target.kind === "url"
        ? "Open in browser"
        : recipient === undefined
          ? "View trace"
          : `View trace for ${recipient}`
  return (
    <button
      type="button"
      aria-label={error ?? label}
      title={error ?? label}
      className={cn(
        target.kind === "session"
          ? "agent-trace-link text-xs"
          : "mr-1.5 shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:bg-muted focus-visible:opacity-100 group-hover/tool:opacity-100",
        error !== undefined && "text-destructive opacity-100",
      )}
      onClick={() => {
        setError(undefined)
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
      {target.kind === "session" ? (
        <>
          <span>{compact ? "View trace" : (recipient ?? "View trace")}</span>
          <ArrowUpRight className="size-3.5" />
        </>
      ) : (
        <ExternalLink className="size-3.5" />
      )}
    </button>
  )
}

function failureSummary(entry: ToolEntry): string | undefined {
  if (entry.state === "interrupted") return "Interrupted"
  if (entry.state !== "failed") return undefined
  const message = entry.resultErrorMessage ?? "Failed"
  return message.length <= 72 ? message : `${message.slice(0, 71)}…`
}
