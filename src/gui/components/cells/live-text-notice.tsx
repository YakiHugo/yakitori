import type { ExecutionEntry } from "../../execution-view.ts"

export function LiveTextNotice({
  entry,
}: {
  entry: Pick<
    Extract<ExecutionEntry, { kind: "assistant" | "reasoning" }>,
    "status" | "incomplete"
  >
}) {
  if (!entry.incomplete) return null
  return (
    <p className="py-1 text-xs text-muted-foreground">
      {entry.status === "suspended"
        ? "Live text paused. Waiting to reconnect."
        : entry.status === "partial"
          ? "Partial text. Waiting for saved output."
          : entry.status === "streaming"
            ? "Partial live text. The full response will appear when saved."
            : "Partial text. Some live output could not be recovered."}
    </p>
  )
}
