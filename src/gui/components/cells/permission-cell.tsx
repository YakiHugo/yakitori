import { ShieldAlert } from "lucide-react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { useTranslation } from "../../i18n/use-translation.ts"
import { Badge } from "../ui/badge.tsx"

export function PermissionCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "permission" }>
}) {
  const { t } = useTranslation()
  const behavior =
    entry.behavior === "allow" || entry.behavior === "deny"
      ? t(entry.behavior)
      : entry.behavior
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-detail text-muted-foreground">
      <ShieldAlert className="size-4 shrink-0" />
      <span className="shrink-0 font-medium text-foreground">
        {t("Permission · {0}", entry.action)}
      </span>
      {entry.subject !== undefined && (
        <span className="min-w-0 flex-1 truncate">{entry.subject}</span>
      )}
      <Badge variant={entry.state === "requested" ? "outline" : "secondary"}>
        {entry.state === "requested"
          ? t("awaiting approval")
          : entry.state === "resolving"
            ? `${behavior ?? t("resolving")}…`
            : (behavior ?? t("resolved"))}
      </Badge>
    </div>
  )
}
