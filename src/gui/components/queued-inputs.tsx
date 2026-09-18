import { X } from "lucide-react"
import { useAppStore, useExecutionView } from "../store/app-store.ts"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

export function QueuedInputs() {
  const view = useExecutionView()
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const cancelQueuedInput = useAppStore((state) => state.cancelQueuedInput)

  const queued = view.queuedInputIds.flatMap((inputId) => {
    const entry = view.entries.find(
      (candidate) =>
        candidate.kind === "user_input" && candidate.inputId === inputId,
    )
    return entry && entry.kind === "user_input"
      ? [{ inputId, text: entry.text }]
      : []
  })

  if (queued.length === 0) return null

  return (
    <div className="space-y-1 border-t bg-muted/40 px-4 py-2">
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
