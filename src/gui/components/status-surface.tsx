import { LoaderCircle, Square, X } from "lucide-react"
import { useElapsedSeconds } from "../hooks/use-elapsed-time.ts"
import { formatElapsed } from "../lib/format.ts"
import { useAppStore, useExecutionView } from "../store/app-store.ts"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

export function StatusSurface() {
  const view = useExecutionView()
  const busy = useAppStore((state) => state.busy)
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
  const cancelling =
    activeTurnId === undefined ||
    busy ||
    inFlightActions.has(`cancel:${activeTurnId}`)

  return (
    <div className="space-y-1 border-t bg-muted/40 px-4 py-2">
      {activeTurnId !== undefined && (
        <div className="flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          <span>Working · {formatElapsed(elapsed)}</span>
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
            disabled={cancelling}
            onClick={() => void cancelTurn(activeTurnId)}
          >
            <Square /> Interrupt
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
