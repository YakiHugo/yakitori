import { CircleX, OctagonX, TriangleAlert } from "lucide-react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { useTranslation } from "../../i18n/use-translation.ts"
import { cn } from "../../lib/utils.ts"

const terminalLabels = {
  failed: "Turn failed",
  cancelled: "Turn cancelled",
  interrupted: "Turn interrupted",
  truncated: "Response truncated",
  refused: "Response refused",
} as const

export function TurnTerminalCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "turn_terminal" }>
}) {
  const { t } = useTranslation()
  const Icon =
    entry.state === "failed"
      ? CircleX
      : entry.state === "cancelled"
        ? OctagonX
        : TriangleAlert
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-detail",
        entry.state === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span>
        {t(terminalLabels[entry.state])} — {entry.message}
      </span>
    </div>
  )
}
