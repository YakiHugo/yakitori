import { useTranslation } from "../i18n/use-translation.ts"
import { LoaderCircle } from "lucide-react"
import { useState } from "react"
import { useAppStore } from "../store/app-store.ts"
import {
  totalTokens,
  type UsageRange,
  usageCalendar,
  usageView,
} from "../usage-view.ts"
import { UsageHeatmap } from "./usage-heatmap.tsx"

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const exact = new Intl.NumberFormat("en")

export function UsageSection() {
  const { locale, t } = useTranslation()
  const usage = useAppStore((state) => state.usage)
  const loadUsage = useAppStore((state) => state.loadUsage)
  const [range, setRange] = useState<UsageRange>(30)
  const [selectedDate, setSelectedDate] = useState<string>()
  const [breakdown, setBreakdown] = useState<"model" | "day">("model")
  const summary = usage.summary
  const unavailableThreads = summary?.unavailableThreads ?? 0
  const view = summary && usageView(summary, range, selectedDate)
  const calendar = summary ? usageCalendar(summary, 366) : []
  const total = view ? totalTokens(view.totals) : 0
  const breakdownDays =
    view?.days.filter((day) => !selectedDate || day.date === selectedDate) ?? []
  const period =
    selectedDate ??
    (range === "all" ? t("All time") : t("Last {0} days", range))
  return (
    <div className="usage-dashboard" aria-busy={usage.loading}>
      {usage.error || unavailableThreads > 0 ? (
        <div className="usage-retry">
          <button
            type="button"
            aria-label={t("Retry usage")}
            disabled={usage.loading}
            onClick={() => void loadUsage()}
          >
            {usage.loading ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              t("Retry")
            )}
          </button>
        </div>
      ) : null}
      {usage.error && (
        <p role="alert">
          {usage.error}
          {summary ? t("Showing the previous result.") : ""}
        </p>
      )}
      {unavailableThreads > 0 && (
        <p role="alert">
          {unavailableThreads === 1
            ? t(
                "Usage is incomplete: 1 conversation history could not be read. You can retry loading it.",
              )
            : t(
                "Usage is incomplete: {0} conversation histories could not be read. You can retry loading them.",
                unavailableThreads,
              )}
        </p>
      )}
      {!summary || !view ? (
        <p role="status">
          {usage.loading
            ? t("Loading usage…")
            : usage.error
              ? t("Retry to load usage.")
              : t("Usage has not been loaded.")}
        </p>
      ) : (
        <>
          <div className="usage-toolbar">
            <fieldset className="usage-range" aria-label={t("Usage period")}>
              {([7, 30, 90, 366, "all"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={range === value && selectedDate === undefined}
                  onClick={() => {
                    setRange(value)
                    setSelectedDate(undefined)
                  }}
                >
                  {value === "all"
                    ? t("All time")
                    : value === 366
                      ? t("Year")
                      : `${value}D`}
                </button>
              ))}
            </fieldset>
            <span className="usage-muted">{t("UTC · Local records")}</span>
          </div>
          {selectedDate && (
            <div className="usage-period-heading">
              <button type="button" onClick={() => setSelectedDate(undefined)}>
                {t("Clear day filter")}
              </button>
            </div>
          )}
          <div className="usage-overview">
            <section className="usage-headline" aria-label={t("Period total")}>
              <span className="usage-muted">
                {period} {t("· Tokens")}
              </span>
              <strong className="usage-total" title={exact.format(total)}>
                <span aria-hidden="true">{compact.format(total)}</span>
                <span className="sr-only">
                  {exact.format(total)} {t("total tokens")}
                </span>
              </strong>
              <p className="usage-muted">
                {exact.format(view.totals.turns)} {t("recorded turns")}
              </p>
            </section>
            <DailyTrend
              days={view.days}
              range={range}
              selectedDate={selectedDate}
              onSelect={setSelectedDate}
            />
          </div>
          {view.totals.turns === 0 && total === 0 && (
            <p className="usage-empty">
              {t(
                "No recorded usage in this period. Usage appears after model requests report it.",
              )}
            </p>
          )}
          <section
            className="usage-card usage-comparison"
            aria-label={t("Usage by model")}
          >
            <div className="usage-card-heading">
              <h4>{t("Models")}</h4>
              {view.models.length > 5 && (
                <span>
                  {t("Top 5 of")} {view.models.length}
                </span>
              )}
            </div>
            {view.models.length === 0 ? (
              <p className="usage-muted">
                {t("No models recorded in this period.")}
              </p>
            ) : (
              <ul className="usage-model-comparison">
                {view.models.slice(0, 5).map((model) => (
                  <li key={JSON.stringify([model.provider, model.model])}>
                    <div className="usage-model-label">
                      <strong>{model.model || t("Unknown model")}</strong>
                      <small>{model.provider || t("Unknown provider")}</small>
                    </div>
                    <div className="usage-share-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${total > 0 ? (totalTokens(model) / total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <div className="usage-model-value">
                      <strong title={exact.format(totalTokens(model))}>
                        {compact.format(totalTokens(model))}
                      </strong>
                      <small>
                        {total > 0
                          ? `${((totalTokens(model) / total) * 100).toFixed(1)}%`
                          : "—"}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <UsageHeatmap
            days={calendar}
            selectedDate={selectedDate}
            onSelect={(date) => {
              setRange(366)
              setSelectedDate(date)
            }}
          />
          <details className="usage-details">
            <summary>{t("Usage details")}</summary>
            <section className="usage-totals" aria-label={t("Token totals")}>
              <h4>{t("Totals")}</h4>
              <div className="usage-stat-grid">
                <Stat
                  label={t("Input tokens")}
                  value={view.totals.inputTokens}
                  detail="Includes cached input"
                />
                <Stat
                  label={t("Output tokens")}
                  value={view.totals.outputTokens}
                  detail="Recorded model output"
                />
                <Stat
                  label={t("Cache read")}
                  value={view.totals.cacheReadInputTokens}
                  detail="Included in input"
                />
                <Stat
                  label={t("Cache write")}
                  value={view.totals.cacheWriteInputTokens}
                  detail="Included in input"
                />
                <div className="usage-stat">
                  <span>{t("Input cache hit")}</span>
                  <strong>
                    {view.totals.inputTokens > 0
                      ? `${((view.totals.cacheReadInputTokens / view.totals.inputTokens) * 100).toFixed(1)}%`
                      : "—"}
                  </strong>
                  <small>{t("Cache read / input")}</small>
                </div>
              </div>
            </section>
            <section
              className="usage-card"
              aria-label={
                breakdown === "model"
                  ? t("Detailed model usage")
                  : t("Usage by day")
              }
            >
              <div className="usage-card-heading">
                <div>
                  <h4>{t("Breakdown")}</h4>
                  <span className="usage-muted">
                    {breakdown === "day" && range === "all" && !selectedDate
                      ? t("Last 30 days · UTC")
                      : period}
                  </span>
                </div>
                <fieldset
                  className="usage-range"
                  aria-label={t("Breakdown grouping")}
                >
                  {(["model", "day"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={breakdown === value}
                      onClick={() => setBreakdown(value)}
                    >
                      {value === "model" ? t("Model") : t("Day")}
                    </button>
                  ))}
                </fieldset>
              </div>
              {breakdown === "day" ? (
                <div className="usage-table-scroll">
                  <table className="usage-threads usage-models">
                    <thead>
                      <tr>
                        <th>{t("Day · UTC")}</th>
                        <th>{t("Turns")}</th>
                        <th>{t("Input")}</th>
                        <th>{t("Output")}</th>
                        <th>{t("Cache read")}</th>
                        <th>{t("Total tokens")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...breakdownDays].reverse().map((day) => (
                        <tr key={day.date}>
                          <td>
                            <button
                              type="button"
                              className="usage-day-link"
                              onClick={() =>
                                setSelectedDate(
                                  selectedDate === day.date
                                    ? undefined
                                    : day.date,
                                )
                              }
                            >
                              {day.date}
                            </button>
                          </td>
                          <td>{exact.format(day.turns)}</td>
                          <td>{exact.format(day.inputTokens)}</td>
                          <td>{exact.format(day.outputTokens)}</td>
                          <td>{exact.format(day.cacheReadInputTokens)}</td>
                          <td>{exact.format(totalTokens(day))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : view.models.length === 0 ? (
                <p className="usage-muted">
                  {t("No models recorded in this period.")}
                </p>
              ) : (
                <div className="usage-table-scroll">
                  <table className="usage-threads usage-models">
                    <thead>
                      <tr>
                        <th>{t("Model / provider")}</th>
                        <th>{t("Turns")}</th>
                        <th>{t("Input")}</th>
                        <th>{t("Output")}</th>
                        <th>{t("Cache read")}</th>
                        <th>{t("Total / share")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.models.map((model) => (
                        <tr key={JSON.stringify([model.provider, model.model])}>
                          <td>
                            <strong>{model.model || t("Unknown model")}</strong>
                            <small>
                              {model.provider || t("Unknown provider")}
                            </small>
                          </td>
                          <td>{exact.format(model.turns)}</td>
                          <td title={exact.format(model.inputTokens)}>
                            {compact.format(model.inputTokens)}
                          </td>
                          <td title={exact.format(model.outputTokens)}>
                            {compact.format(model.outputTokens)}
                          </td>
                          <td title={exact.format(model.cacheReadInputTokens)}>
                            {compact.format(model.cacheReadInputTokens)}
                          </td>
                          <td>
                            <strong title={exact.format(totalTokens(model))}>
                              {compact.format(totalTokens(model))}
                            </strong>
                            <small>
                              {total > 0
                                ? `${((totalTokens(model) / total) * 100).toFixed(1)}%`
                                : "—"}
                            </small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="usage-card" aria-label={t("Top conversations")}>
              <div className="usage-card-heading">
                <h4>{t("Top conversations")}</h4>
                <span>{t("All-time totals · Top 20")}</span>
              </div>
              {summary.threads.length === 0 ? (
                <p className="usage-muted">
                  {t("No conversations recorded yet.")}
                </p>
              ) : (
                <div className="usage-table-scroll">
                  <table className="usage-threads">
                    <thead>
                      <tr>
                        <th>{t("Conversation")}</th>
                        <th>{t("Turns")}</th>
                        <th>{t("Total tokens")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.threads.map((thread) => (
                        <tr key={thread.threadId}>
                          <td title={thread.title || thread.threadId}>
                            {thread.title || thread.threadId}
                          </td>
                          <td>{exact.format(thread.turns)}</td>
                          <td title={exact.format(thread.totalTokens)}>
                            {compact.format(thread.totalTokens)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <p className="usage-footnote">
              {t(
                "Provider-reported usage in this Yakitori data store, including saved usage from running turns. Cache reads and writes are included in input, not added again. Missing usage is excluded. This is not account-wide billing or subscription quota.",
              )}
            </p>
            <p className="usage-footnote">
              {t("Updated")}{" "}
              {new Date(summary.generatedAt).toLocaleString(locale)}{" "}
              {t("· Calendar dates use UTC")}
            </p>
          </details>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  detail,
}: Readonly<{ label: string; value: number; detail: string }>) {
  return (
    <div className="usage-stat">
      <span>{label}</span>
      <strong title={exact.format(value)}>{compact.format(value)}</strong>
      <small>{detail}</small>
    </div>
  )
}

function DailyTrend({
  days,
  range,
  selectedDate,
  onSelect,
}: Readonly<{
  days: ReturnType<typeof usageCalendar>
  range: UsageRange
  selectedDate: string | undefined
  onSelect: (date: string | undefined) => void
}>) {
  const { t } = useTranslation()
  const [focusedDate, setFocusedDate] = useState<string>()
  const tabStopDate = days.some((day) => day.date === focusedDate)
    ? focusedDate
    : (selectedDate ?? days.at(-1)?.date)
  const peak = Math.max(1, ...days.map(totalTokens))
  const x = (index: number) => ((index + 0.5) / days.length) * 1000
  const y = (value: number) => 200 - (value / peak) * 190
  const combined = days
    .map((day, index) => `${x(index)},${y(totalTokens(day))}`)
    .join(" ")
  return (
    <section className="usage-daily" aria-label={t("Daily usage")}>
      <div className="usage-card-heading">
        <h4>{t("Daily tokens")}</h4>
        {(range === "all" || selectedDate) && (
          <span>
            {range === "all" ? t("Last 30 days") : t("Last {0} days", range)}
          </span>
        )}
      </div>
      <div className="usage-chart">
        <div className="usage-chart-scale" aria-hidden="true">
          <span>{compact.format(peak)}</span>
          <span>{compact.format(peak / 2)}</span>
          <span>0</span>
        </div>
        <div className="usage-chart-plot">
          <svg
            viewBox="0 0 1000 200"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {[10, 105, 200].map((line) => (
              <line
                key={line}
                x1="0"
                x2="1000"
                y1={line}
                y2={line}
                className="usage-chart-grid"
              />
            ))}
            <polygon
              points={`${x(0)},200 ${combined} ${x(days.length - 1)},200`}
              className="usage-area-total"
            />
            <polyline points={combined} className="usage-line-total" />
          </svg>
          <fieldset
            className="usage-trend"
            aria-label={t(
              "Daily trend, left and right arrow keys move between days",
            )}
          >
            {days.map((day, index) => (
              <button
                type="button"
                key={day.date}
                tabIndex={day.date === tabStopDate ? 0 : -1}
                onFocus={() => setFocusedDate(day.date)}
                onKeyDown={(event) => {
                  const targetIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? days.length - 1
                        : event.key === "ArrowLeft"
                          ? Math.max(0, index - 1)
                          : event.key === "ArrowRight"
                            ? Math.min(days.length - 1, index + 1)
                            : undefined
                  if (targetIndex === undefined) return
                  event.preventDefault()
                  const target =
                    event.currentTarget.parentElement?.children[targetIndex]
                  if (target instanceof HTMLButtonElement) target.focus()
                }}
                title={t(
                  "{0}: {1} tokens, {2} turns",
                  day.date,
                  exact.format(totalTokens(day)),
                  day.turns,
                )}
                aria-label={t(
                  "{0}: {1} tokens",
                  day.date,
                  exact.format(totalTokens(day)),
                )}
                aria-pressed={selectedDate === day.date}
                onClick={() =>
                  onSelect(selectedDate === day.date ? undefined : day.date)
                }
              />
            ))}
          </fieldset>
        </div>
      </div>
      <div className="usage-axis">
        <span>{days[0]?.date}</span>
        <span>{days.at(-1)?.date}</span>
      </div>
    </section>
  )
}
