import { LoaderCircle, RefreshCw } from "lucide-react"
import { useState } from "react"
import { useAppStore } from "../store/app-store.ts"
import {
  totalTokens,
  usageCalendar,
  type UsageRange,
  usageView,
} from "../usage-view.ts"

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const exact = new Intl.NumberFormat("en")

export function UsageSection() {
  const usage = useAppStore((state) => state.usage)
  const loadUsage = useAppStore((state) => state.loadUsage)
  const [range, setRange] = useState<UsageRange>(30)
  const [selectedDate, setSelectedDate] = useState<string>()
  const summary = usage.summary
  const view = summary && usageView(summary, range, selectedDate)
  const calendar = summary ? usageCalendar(summary, 366) : []
  const peak = Math.max(1, ...calendar.map(totalTokens))
  const total = view ? totalTokens(view.totals) : 0
  const trendPeak = Math.max(1, ...(view?.days.map(totalTokens) ?? []))
  const period =
    selectedDate ?? (range === "all" ? "All time" : `Last ${range} days`)
  return (
    <div className="usage-dashboard">
      <div className="settings-section-heading settings-usage-heading">
        <h3>Usage</h3>
        <p>Understand where your tokens go.</p>
        <button
          type="button"
          aria-label="Refresh usage"
          disabled={usage.loading}
          onClick={() => void loadUsage()}
        >
          {usage.loading ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : (
            <RefreshCw size={16} />
          )}
        </button>
      </div>
      {usage.error && (
        <p role="alert">
          {usage.error}
          {summary ? " Showing the previous result." : ""}
        </p>
      )}
      {!summary || !view ? (
        <p role="status">
          {usage.loading
            ? "Loading usage…"
            : usage.error
              ? "Refresh to try again."
              : "Usage has not been loaded."}
        </p>
      ) : (
        <>
          <div className="usage-toolbar">
            <fieldset className="usage-range" aria-label="Usage period">
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
                    ? "All time"
                    : value === 366
                      ? "Year"
                      : `${value}D`}
                </button>
              ))}
            </fieldset>
            <span className="usage-muted">UTC · Local records</span>
          </div>
          <div className="usage-period-heading">
            <h4>{period}</h4>
            {selectedDate && (
              <button type="button" onClick={() => setSelectedDate(undefined)}>
                Clear day filter
              </button>
            )}
          </div>
          <div className="usage-stat-grid">
            <Stat label="Total tokens" value={total} detail="Input + output" />
            <Stat
              label="Input tokens"
              value={view.totals.inputTokens}
              detail="Includes cached input"
            />
            <Stat
              label="Output tokens"
              value={view.totals.outputTokens}
              detail="Recorded model output"
            />
            <Stat
              label="Recorded turns"
              value={view.totals.turns}
              detail="With reported usage"
            />
          </div>
          <div className="usage-cache-strip">
            <span>
              Cache read{" "}
              <strong title={exact.format(view.totals.cacheReadInputTokens)}>
                {compact.format(view.totals.cacheReadInputTokens)}
              </strong>
            </span>
            <span>
              Cache write{" "}
              <strong title={exact.format(view.totals.cacheWriteInputTokens)}>
                {compact.format(view.totals.cacheWriteInputTokens)}
              </strong>
            </span>
            <span>
              Input cache hit{" "}
              <strong>
                {view.totals.inputTokens > 0
                  ? `${((view.totals.cacheReadInputTokens / view.totals.inputTokens) * 100).toFixed(1)}%`
                  : "—"}
              </strong>
            </span>
          </div>
          {view.totals.turns === 0 && (
            <p className="usage-empty">
              No recorded usage in this period. Turns appear here after they
              finish and report usage.
            </p>
          )}
          <section className="usage-card" aria-label="Daily usage">
            <div className="usage-card-heading">
              <h4>Daily tokens</h4>
              <span>
                {range === "all" ? "Last 30 days" : `Last ${range} days`} · UTC
              </span>
            </div>
            <fieldset
              className="usage-trend"
              style={{ gap: view.days.length > 90 ? "0.5px" : "3px" }}
              aria-label="Select a day to inspect usage"
            >
              {view.days.map((day) => (
                <button
                  type="button"
                  key={day.date}
                  title={`${day.date}: ${exact.format(totalTokens(day))} tokens, ${day.turns} turns`}
                  aria-label={`${day.date}: ${exact.format(totalTokens(day))} tokens`}
                  aria-pressed={selectedDate === day.date}
                  onClick={() =>
                    setSelectedDate(
                      selectedDate === day.date ? undefined : day.date,
                    )
                  }
                >
                  <span
                    style={{
                      height: `${(totalTokens(day) / trendPeak) * 100}%`,
                    }}
                  />
                </button>
              ))}
            </fieldset>
            <div className="usage-axis">
              <span>{view.days[0]?.date}</span>
              <span>{view.days.at(-1)?.date}</span>
            </div>
          </section>
          <section className="usage-card" aria-label="Activity heatmap">
            <div className="usage-card-heading">
              <h4>Activity</h4>
              <span>
                {calendar.filter((day) => day.turns > 0).length} active days ·
                Last 366 days
              </span>
            </div>
            <div className="usage-calendar-scroll">
              <fieldset
                className="usage-calendar"
                aria-label="Daily token activity, arrow keys move between days"
              >
                {calendar.map((day, index) => (
                  <button
                    type="button"
                    key={day.date}
                    tabIndex={
                      selectedDate === day.date ||
                      (!selectedDate && index === calendar.length - 1)
                        ? 0
                        : -1
                    }
                    style={{
                      gridRow:
                        new Date(`${day.date}T00:00:00Z`).getUTCDay() + 1,
                    }}
                    data-level={
                      totalTokens(day) === 0
                        ? 0
                        : Math.min(4, Math.ceil((totalTokens(day) / peak) * 4))
                    }
                    aria-pressed={selectedDate === day.date}
                    aria-label={`${day.date}: ${exact.format(totalTokens(day))} tokens, ${day.turns} turns`}
                    title={`${day.date} · ${exact.format(totalTokens(day))} tokens · ${day.turns} turns`}
                    onClick={() => {
                      setRange(366)
                      setSelectedDate(
                        selectedDate === day.date ? undefined : day.date,
                      )
                    }}
                    onKeyDown={(event) => {
                      const offset = (
                        {
                          ArrowUp: -1,
                          ArrowDown: 1,
                          ArrowLeft: -7,
                          ArrowRight: 7,
                        } as Record<string, number>
                      )[event.key]
                      if (offset === undefined) return
                      event.preventDefault()
                      const target =
                        event.currentTarget.parentElement?.children[
                          Math.max(
                            0,
                            Math.min(calendar.length - 1, index + offset),
                          )
                        ]
                      if (target instanceof HTMLButtonElement) target.focus()
                    }}
                  />
                ))}
              </fieldset>
            </div>
            <div className="usage-axis">
              <span>{calendar[0]?.date}</span>
              <span className="usage-legend">
                Less{" "}
                {[0, 1, 2, 3, 4].map((level) => (
                  <i key={level} data-level={level} />
                ))}{" "}
                More
              </span>
              <span>{calendar.at(-1)?.date}</span>
            </div>
          </section>
          <section className="usage-card" aria-label="Usage by model">
            <div className="usage-card-heading">
              <h4>By model</h4>
              <span>{period}</span>
            </div>
            {view.models.length === 0 ? (
              <p className="usage-muted">No models recorded in this period.</p>
            ) : (
              <div className="usage-table-scroll">
                <table className="usage-threads usage-models">
                  <thead>
                    <tr>
                      <th>Model / provider</th>
                      <th>Turns</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Cache read</th>
                      <th>Total / share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.models.map((model) => (
                      <tr key={JSON.stringify([model.provider, model.model])}>
                        <td>
                          <strong>{model.model || "Unknown model"}</strong>
                          <small>{model.provider || "Unknown provider"}</small>
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
          <section className="usage-card" aria-label="Top conversations">
            <div className="usage-card-heading">
              <h4>Top conversations</h4>
              <span>All-time totals · Top 20</span>
            </div>
            {summary.threads.length === 0 ? (
              <p className="usage-muted">No conversations recorded yet.</p>
            ) : (
              <div className="usage-table-scroll">
                <table className="usage-threads">
                  <thead>
                    <tr>
                      <th>Conversation</th>
                      <th>Turns</th>
                      <th>Total tokens</th>
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
            Completed turns with usage recorded on this device only. Cache reads
            and writes are included in input, not added again. Missing usage and
            in-progress turns are excluded. This is not a billing statement;
            subscription limits are in Subscriptions.
          </p>
          <p className="usage-footnote">
            Updated {new Date(summary.generatedAt).toLocaleString()} · Calendar
            dates use UTC
          </p>
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
