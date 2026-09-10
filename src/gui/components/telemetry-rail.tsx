import { useExecutionView } from "../store/app-store.ts"

export function TelemetryRail() {
  const telemetry = useExecutionView().telemetry
  const cacheHit =
    telemetry.inputTokens === 0
      ? undefined
      : (telemetry.cacheReadInputTokens / telemetry.inputTokens) * 100
  const tokensPerSecond =
    telemetry.modelDurationMs === 0
      ? undefined
      : telemetry.outputTokens / (telemetry.modelDurationMs / 1_000)
  const items = [
    `${telemetry.turns} ${telemetry.turns === 1 ? "turn" : "turns"}`,
    `${telemetry.steps} steps`,
    `LLM ${formatDuration(telemetry.modelDurationMs)}`,
    `Tools ${formatDuration(telemetry.toolDurationMs)}`,
    `TTFT avg ${telemetry.averageTimeToFirstTokenMs === undefined ? "—" : formatDuration(telemetry.averageTimeToFirstTokenMs)}`,
    `${tokensPerSecond === undefined ? "—" : formatRate(tokensPerSecond)} tok/s`,
    `Cache hit ${cacheHit === undefined ? "—" : `${Math.round(cacheHit)}%`}`,
    `Input ${formatTokens(telemetry.inputTokens)} tok`,
  ]

  return (
    <div
      role="status"
      aria-label="Session telemetry"
      className="flex items-center justify-center gap-2 overflow-x-auto px-3 pt-1 pb-2 text-[11px] whitespace-nowrap text-muted-foreground"
      title={`Provider-reported cache reads: ${formatTokens(telemetry.cacheReadInputTokens)} tokens · cache writes: ${formatTokens(telemetry.cacheWriteInputTokens)} tokens`}
    >
      {items.map((item, index) => (
        <span key={item} className="flex items-center gap-2">
          {index === 0 ? null : <span className="text-border">|</span>}
          {item}
        </span>
      ))}
    </div>
  )
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1_000)
  return `${minutes}m${seconds}s`
}

function formatRate(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString()
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}
