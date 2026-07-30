import { ShieldAlert } from "lucide-react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { Badge } from "../ui/badge.tsx"

export function PermissionCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "permission" }>
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
      <ShieldAlert className="size-4 shrink-0" />
      <span className="shrink-0 font-medium text-foreground">
        Permission · {entry.action}
      </span>
      {entry.subject !== undefined && (
        <span className="min-w-0 flex-1 truncate">{entry.subject}</span>
      )}
      <Badge variant={entry.state === "requested" ? "outline" : "secondary"}>
        {entry.state === "requested"
          ? "awaiting approval"
          : (entry.behavior ?? entry.state)}
      </Badge>
    </div>
  )
}
