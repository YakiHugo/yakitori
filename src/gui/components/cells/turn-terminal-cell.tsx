import { CircleX, OctagonX, TriangleAlert } from "lucide-react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { cn } from "../../lib/utils.ts"

export function TurnTerminalCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "turn_terminal" }>
}) {
  const Icon =
    entry.state === "failed"
      ? CircleX
      : entry.state === "cancelled"
        ? OctagonX
        : TriangleAlert
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm",
        entry.state === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span>
        Turn {entry.state} — {entry.message}
      </span>
    </div>
  )
}
