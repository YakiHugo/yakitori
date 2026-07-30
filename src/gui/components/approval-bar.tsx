import { ShieldAlert } from "lucide-react"
import type { ExecutionEntry } from "../execution-view.ts"
import { useAppStore, useExecutionView } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"

export function ApprovalBar() {
  const view = useExecutionView()
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const resolvePermission = useAppStore((state) => state.resolvePermission)

  const pending = view.entries.filter(
    (entry): entry is Extract<ExecutionEntry, { kind: "permission" }> =>
      entry.kind === "permission" && entry.state === "requested",
  )
  if (pending.length === 0) return null

  return (
    <div className="space-y-2 border-t border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950/40">
      {pending.map((entry) => {
        const busy = inFlightActions.has(
          `permission:${entry.permissionRequestId}`,
        )
        return (
          <div
            key={entry.permissionRequestId}
            className="flex items-center gap-3"
          >
            <ShieldAlert className="size-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Permission · {entry.action}</p>
              {entry.subject !== undefined && (
                <p className="truncate text-xs text-muted-foreground">
                  {entry.subject}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Runs with host user authority (files, process, network).
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void resolvePermission(
                  entry.turnId,
                  entry.permissionRequestId,
                  "allow",
                )
              }
            >
              Allow
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void resolvePermission(
                  entry.turnId,
                  entry.permissionRequestId,
                  "deny",
                )
              }
            >
              Deny
            </Button>
          </div>
        )
      })}
    </div>
  )
}
