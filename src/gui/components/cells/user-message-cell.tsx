import type { ExecutionEntry } from "../../execution-view.ts"
import { Badge } from "../ui/badge.tsx"

export function UserMessageCell({
  entry,
  queued,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "user_input" }>
  readonly queued: boolean
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
        {entry.text}
      </div>
      {queued && <Badge variant="secondary">queued</Badge>}
    </div>
  )
}
