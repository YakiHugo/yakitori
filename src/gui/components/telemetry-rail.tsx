import { useTranslation } from "../i18n/use-translation.ts"
import { ChevronDown } from "lucide-react"
import { useAppStore } from "../store/app-store.ts"
import "./telemetry-rail.css"

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const exact = new Intl.NumberFormat("en")

export function TelemetryRail() {
  const { t } = useTranslation()
  const historyBefore = useAppStore((state) => state.historyBefore)
  const telemetry = useAppStore((state) => state.execution.telemetry)
  const usage = useAppStore((state) => state.execution.lastTurnUsage)
  const metrics = useAppStore((state) => state.execution.lastTurnMetrics)
  const cacheHit =
    telemetry.inputTokens > 0
      ? `${((telemetry.cacheReadInputTokens / telemetry.inputTokens) * 100).toFixed(1)}%`
      : "—"
  const tps =
    usage && metrics && metrics.modelDurationMs > 0
      ? (usage.outputTokens / (metrics.modelDurationMs / 1_000)).toFixed(1)
      : "—"
  const total = telemetry.inputTokens + telemetry.outputTokens
  return (
    <details className="telemetry-rail">
      <summary aria-label={t("Session telemetry")}>
        <span className="telemetry-caption">{t("Session")}</span>
        <span
          title={t("Average time to first token across measured model calls")}
        >
          {t("Avg TTFT")}{" "}
          <strong>{duration(telemetry.averageTimeToFirstTokenMs)}</strong>
        </span>
        {historyBefore === undefined ? (
          <span
            title={t("{0} total input and output tokens", exact.format(total))}
          >
            {t("Tokens")} <strong>{compact.format(total)}</strong>
          </span>
        ) : null}
        <span
          title={t("Provider-reported cached input tokens / all input tokens")}
        >
          {t("Cache hit")} <strong>{cacheHit}</strong>
        </span>
        <span
          title={t(
            "Last completed turn: output tokens / model time, including first-token wait",
          )}
        >
          TPS <strong>{tps}</strong>
        </span>
        <ChevronDown
          size={12}
          className="telemetry-chevron"
          aria-hidden="true"
        />
      </summary>
      <section
        className="telemetry-dashboard"
        aria-label={t("Session metrics")}
      >
        <div className="telemetry-dashboard-heading">
          <span>{t("Token usage")}</span>
          <span>
            {telemetry.turns} {t("completed turns ·")} {telemetry.steps} steps
          </span>
        </div>
        <dl>
          <div>
            <dt>{t("Input")}</dt>
            <dd>{exact.format(telemetry.inputTokens)}</dd>
          </div>
          <div>
            <dt>{t("Output")}</dt>
            <dd>{exact.format(telemetry.outputTokens)}</dd>
          </div>
          <div>
            <dt>{t("Cache read")}</dt>
            <dd>{exact.format(telemetry.cacheReadInputTokens)}</dd>
          </div>
          <div>
            <dt>{t("Cache write")}</dt>
            <dd>{exact.format(telemetry.cacheWriteInputTokens)}</dd>
          </div>
          <div>
            <dt>{t("Model time")}</dt>
            <dd>{duration(telemetry.modelDurationMs)}</dd>
          </div>
          <div>
            <dt>{t("Tool time")}</dt>
            <dd>{duration(telemetry.toolDurationMs)}</dd>
          </div>
        </dl>
        <p>
          {t(
            "Tokens include cached input. Timing updates when a turn finishes. TPS is output tokens per second of model time in the last completed turn, including the first-token wait; tool time is excluded.",
          )}
        </p>
      </section>
    </details>
  )
}

function duration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "—"
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`
  const seconds = Math.round(milliseconds / 1_000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
