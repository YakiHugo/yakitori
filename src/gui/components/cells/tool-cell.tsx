import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  FilePenLine,
  FileText,
  Globe,
  LoaderCircle,
  Plug,
  Search,
  Terminal,
  Users,
  Wrench,
} from "lucide-react"
import { useEffect, useId, useState } from "react"
import {
  parseSessionPlan,
  parseUserQuestions,
} from "../../../protocol/user-interaction.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import {
  fileActionLabel,
  openFileTarget,
  openUrlTarget,
} from "../../lib/open-resource.ts"
import { cn } from "../../lib/utils.ts"
import { useAppStore } from "../../store/app-store.ts"
import { presentTool, type ToolTarget } from "../../tool-presentation.ts"
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible.tsx"
import { TranscriptDisclosureContent } from "../transcript-disclosure.tsx"
import { PlanCell, UserQuestionsCell } from "./session-progress-cell.tsx"
import { ToolDetailView } from "./tool-detail.tsx"
import { ToolResultParts } from "./tool-result-parts.tsx"
import "../activity-timeline.css"

type ToolEntry = Extract<ExecutionEntry, { readonly kind: "tool" }>

export function ToolCell({
  entry,
  workspaceRoot,
  onOpenSession,
  onExpandedChange,
  apiBase: apiBaseOverride,
}: Readonly<{
  entry: ToolEntry
  workspaceRoot?: string | undefined
  onOpenSession?: ((sessionId: string) => Promise<void>) | undefined
  onExpandedChange?: ((expanded: boolean) => void) | undefined
  apiBase?: string | undefined
}>) {
  const storeApiBase = useAppStore((state) => state.apiBase)
  const apiBase = apiBaseOverride ?? storeApiBase
  const presentation = presentTool(entry)
  const collaboration =
    presentation.detail?.kind === "collaboration"
      ? presentation.detail
      : undefined
  const [open, setOpen] = useState(
    entry.state === "failed" || entry.state === "interrupted",
  )
  const active = entry.state === "requested"
  const contentId = useId()
  const failed = entry.state === "failed" || entry.resultError === true
  const interrupted = entry.state === "interrupted"
  const subject =
    presentation.target?.kind === "file" &&
    presentation.subject === presentation.target.path
      ? (presentation.subject.split(/[\\/]/).filter(Boolean).at(-1) ??
        presentation.subject)
      : presentation.subject
  const statusLabel = failed
    ? "Failed"
    : interrupted
      ? "Interrupted"
      : undefined
  const triggerLabel =
    subject === presentation.subject
      ? undefined
      : [
          active ? presentation.activeVerb : presentation.verb,
          presentation.subject,
          statusLabel,
          ...presentation.meta,
        ]
          .filter(Boolean)
          .join(" ")
  const Icon = active
    ? LoaderCircle
    : failed
      ? CircleAlert
      : {
          command_execution: Terminal,
          file_change: FilePenLine,
          file_read: FileText,
          file_search: Search,
          web_fetch: Globe,
          web_search: Globe,
          collaboration_tool_call: Users,
          mcp_tool_call: Plug,
          dynamic_tool_call: Wrench,
        }[entry.execution.type]

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
      onOpenChange={(expanded) => {
        setOpen(expanded)
        onExpandedChange?.(expanded)
      }}
      className={cn(
        "group/tool",
        "tool-cell",
        collaboration !== undefined && "agent-collaboration",
      )}
      data-status={
        failed ? "failed" : interrupted ? "interrupted" : entry.state
      }
      data-notice={
        presentation.meta.some(
          (part) => part === "partial" || part === "timed out",
        ) || undefined
      }
    >
      <div className="tool-header">
        <CollapsibleTrigger
          aria-controls={contentId}
          aria-label={triggerLabel}
          className="tool-trigger"
        >
          <Icon
            aria-hidden="true"
            className={cn("tool-icon", active && "animate-spin")}
          />
          <span className="tool-summary">
            <span className="tool-title">
              <span className={cn("tool-verb", active && "tool-running-label")}>
                {active ? presentation.activeVerb : presentation.verb}
              </span>
              {presentation.subject === "" ? null : (
                <span
                  title={presentation.subject}
                  className={cn(
                    "tool-subject",
                    presentation.subjectTone === "code" && "font-mono",
                  )}
                >
                  {subject}
                </span>
              )}
            </span>
            {failed ||
            interrupted ||
            (collaboration === undefined && presentation.meta.length > 0) ? (
              <span className="tool-meta">
                {failed || interrupted ? (
                  <span className="tool-state" title={entry.resultErrorMessage}>
                    {statusLabel}
                  </span>
                ) : null}
                {(collaboration === undefined ? presentation.meta : []).map(
                  (part) => (
                    <span key={part}>{part}</span>
                  ),
                )}
              </span>
            ) : null}
          </span>
          <ChevronRight aria-hidden="true" className="tool-chevron" />
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
      <TranscriptDisclosureContent
        id={contentId}
        open={open}
        className="tool-details"
      >
        <div className="tool-detail-surface">
          {entry.resultErrorMessage === undefined ||
          presentation.detail?.kind === "command" ||
          entry.resultText?.includes(entry.resultErrorMessage) ? null : (
            <p className="tool-error">{entry.resultErrorMessage}</p>
          )}
          {collaboration?.request === undefined ? null : (
            <p className="tool-collaboration-request">
              {collaboration.request}
            </p>
          )}
          {entry.resultContent?.some((part) => part.type !== "text") ? (
            <ToolResultParts
              parts={entry.resultContent}
              toolCallId={entry.toolCallId}
              apiBase={apiBase}
            />
          ) : (
            <ToolDetailView
              detail={presentation.detail}
              pending={active}
              workspaceRoot={workspaceRoot}
            />
          )}
        </div>
      </TranscriptDisclosureContent>
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
  const [copiedPath, setCopiedPath] = useState<string>()
  const fileKey =
    target.kind === "file" ? `${target.path}:${target.line ?? ""}` : undefined
  const label =
    target.kind === "file"
      ? fileActionLabel()
      : target.kind === "url"
        ? "Open in browser"
        : recipient === undefined
          ? "View trace"
          : `View trace for ${recipient}`
  const copied = label === "Copy path" && copiedPath === fileKey
  const iconOnly = target.kind === "file" && !copied && error === undefined
  const Icon = copied ? Check : label === "Copy path" ? Copy : ExternalLink
  return (
    <button
      type="button"
      aria-label={label}
      aria-description={error}
      title={error ?? label}
      data-icon-only={iconOnly || undefined}
      className={cn(
        target.kind === "session" ? "agent-trace-link" : "tool-resource-action",
        "text-muted-foreground hover:text-foreground",
        error !== undefined && "text-destructive hover:text-destructive",
      )}
      onClick={async () => {
        setError(undefined)
        setCopiedPath(undefined)
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
        await action
          .then(() => {
            if (label === "Copy path") setCopiedPath(fileKey)
          })
          .catch((reason: unknown) => {
            setError(
              reason instanceof Error ? reason.message : "Could not open",
            )
          })
      }}
    >
      {target.kind === "session" ? (
        <>
          <span>{compact ? "View trace" : (recipient ?? "View trace")}</span>
          <ArrowUpRight className="size-3.5" />
        </>
      ) : (
        <>
          <Icon aria-hidden="true" className="size-3.5" />
          <span aria-live="polite" className={iconOnly ? "sr-only" : undefined}>
            {error === undefined ? (copied ? "Copied" : label) : "Retry"}
          </span>
        </>
      )}
    </button>
  )
}
