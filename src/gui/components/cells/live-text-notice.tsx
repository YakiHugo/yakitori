import { useTranslation } from "../../i18n/use-translation.ts"
import type { ExecutionEntry } from "../../execution-view.ts"

export function LiveTextNotice({
  entry,
}: {
  entry: Pick<
    Extract<ExecutionEntry, { kind: "assistant" | "reasoning" }>,
    "status" | "incomplete"
  >
}) {
  const { t } = useTranslation()
  if (!entry.incomplete) return null
  return (
    <p className="py-1 text-caption text-muted-foreground">
      {entry.status === "suspended"
        ? t("Live text paused. Waiting to reconnect.")
        : entry.status === "partial"
          ? t("Partial text. Waiting for saved output.")
          : entry.status === "streaming"
            ? t("Partial live text. The full response will appear when saved.")
            : t("Partial text. Some live output could not be recovered.")}
    </p>
  )
}
