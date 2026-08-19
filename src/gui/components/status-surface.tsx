import {
  LoaderCircle,
  MessageSquareMore,
  ShieldAlert,
  Square,
  Wrench,
  X,
} from "lucide-react"
import type { ActiveTurnActivity } from "../execution-view.ts"
import { useElapsedSeconds } from "../hooks/use-elapsed-time.ts"
import { formatElapsed } from "../lib/format.ts"
import { useAppStore, useExecutionView } from "../store/app-store.ts"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

export function StatusSurface() {
  const view = useExecutionView()
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const cancelTurn = useAppStore((state) => state.cancelTurn)
  const cancelQueuedInput = useAppStore((state) => state.cancelQueuedInput)
  const elapsed = useElapsedSeconds(view.activeTurnStartedAt)

  const queued = view.queuedInputIds.flatMap((inputId) => {
    const entry = view.entries.find(
      (candidate) =>
        candidate.kind === "user_input" && candidate.inputId === inputId,
    )
    return entry && entry.kind === "user_input"
      ? [{ inputId, text: entry.text }]
      : []
  })

  const activeTurnId = view.activeTurnId
  if (activeTurnId === undefined && queued.length === 0) return null
  const stopping =
    activeTurnId !== undefined && inFlightActions.has(`cancel:${activeTurnId}`)

  return (
    <div className="space-y-1 border-t bg-muted/40 px-4 py-2">
      {activeTurnId !== undefined && (
        <div className="flex items-center gap-2 text-sm" aria-live="polite">
          <ActivityIcon activity={view.activeActivity} stopping={stopping} />
          <span>{activityLabel(view.activeActivity, stopping)}</span>
          <span className="text-muted-foreground">
            · {formatElapsed(elapsed)}
          </span>
          {view.lastModel !== undefined && (
            <span className="truncate text-muted-foreground">
              {view.lastModel.provider} · {view.lastModel.model}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={stopping}
            onClick={() => void cancelTurn(activeTurnId)}
          >
            {stopping ? (
              <>
                <LoaderCircle className="animate-spin" /> Stopping…
              </>
            ) : (
              <>
                <Square /> Interrupt
              </>
            )}
          </Button>
        </div>
      )}
      {queued.map((item) => (
        <div
          key={item.inputId}
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Badge variant="secondary">queued</Badge>
          <span className="truncate">{item.text}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="ml-auto size-6"
                aria-label="Cancel queued input"
                disabled={inFlightActions.has(`cancel-input:${item.inputId}`)}
                onClick={() => void cancelQueuedInput(item.inputId)}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Cancel queued input</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  )
}

function ActivityIcon({
  activity,
  stopping,
}: {
  readonly activity: ActiveTurnActivity | undefined
  readonly stopping: boolean
}) {
  if (stopping) {
    return (
      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
    )
  }
  if (activity?.kind === "responding") {
    return <MessageSquareMore className="size-4 text-sky-600" />
  }
  if (activity?.kind === "waiting_permission") {
    return <ShieldAlert className="size-4 text-amber-600" />
  }
  if (activity?.kind === "running_tool") {
    return <Wrench className="size-4 text-emerald-600" />
  }
  return <ReasoningPulse />
}

function ReasoningPulse() {
  return (
    <span className="relative flex size-4 items-center justify-center">
      <span className="absolute size-3 animate-ping rounded-full border border-foreground/20" />
      <span className="size-1.5 rounded-full bg-foreground/55" />
    </span>
  )
}

function activityLabel(
  activity: ActiveTurnActivity | undefined,
  stopping: boolean,
): string {
  if (stopping) return "Stopping"
  if (activity?.kind === "responding") return "Responding"
  if (activity?.kind === "waiting_permission") {
    return `Waiting for approval · ${activity.action}`
  }
  if (activity?.kind === "running_tool") {
    return `Running · ${activity.name}`
  }
  return "Reasoning"
}
