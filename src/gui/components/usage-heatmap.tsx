import { useState } from "react"
import { totalTokens, type usageCalendar } from "../usage-view.ts"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip.tsx"

const exact = new Intl.NumberFormat("en")
const month = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" })
const fullDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

export function UsageHeatmap({
  days,
  selectedDate,
  onSelect,
}: Readonly<{
  days: ReturnType<typeof usageCalendar>
  selectedDate: string | undefined
  onSelect: (date: string | undefined) => void
}>) {
  const [focusedDate, setFocusedDate] = useState<string>()
  const firstWeekday = days[0]
    ? new Date(`${days[0].date}T00:00:00Z`).getUTCDay()
    : 0
  const columns = Math.ceil((firstWeekday + days.length) / 7)
  const peak = Math.max(1, ...days.map(totalTokens))
  const tabStopDate = days.some((day) => day.date === focusedDate)
    ? focusedDate
    : days.some((day) => day.date === selectedDate)
      ? selectedDate
      : days.at(-1)?.date
  const months = days.flatMap((day, index) => {
    if (index !== 0 && !day.date.endsWith("-01")) return []
    // A partial opening month must leave room for the next month's label.
    if (index === 0) {
      const start = new Date(`${day.date}T00:00:00Z`)
      const nextMonth = new Date(start)
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1)
      const daysUntilNextMonth =
        (nextMonth.getTime() - start.getTime()) / 86_400_000
      if (Math.floor((firstWeekday + daysUntilNextMonth) / 7) < 3) return []
    }
    return [
      { date: day.date, column: Math.floor((firstWeekday + index) / 7) + 1 },
    ]
  })
  return (
    <section
      className="usage-card usage-activity"
      aria-label="Activity heatmap"
    >
      <div className="usage-card-heading">
        <h4>Token activity</h4>
        <span>
          {days.filter((day) => day.turns > 0 || totalTokens(day) > 0).length}{" "}
          active days · Last {days.length} days
        </span>
      </div>
      <div className="usage-calendar-scroll">
        <div
          className="usage-calendar-year"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          <TooltipProvider delayDuration={120}>
            <fieldset
              className="usage-calendar"
              aria-label="Daily token activity, arrow keys move between days"
            >
              {days.map((day, index) => {
                const date = new Date(`${day.date}T00:00:00Z`)
                const tokens = totalTokens(day)
                return (
                  <Tooltip key={day.date}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        tabIndex={day.date === tabStopDate ? 0 : -1}
                        style={{
                          gridRow: date.getUTCDay() + 1,
                          gridColumn:
                            Math.floor((firstWeekday + index) / 7) + 1,
                        }}
                        data-level={
                          tokens === 0
                            ? 0
                            : Math.min(4, Math.ceil((tokens / peak) * 4))
                        }
                        aria-pressed={selectedDate === day.date}
                        aria-label={`${day.date}: ${exact.format(tokens)} tokens, ${day.turns} turns`}
                        onFocus={() => setFocusedDate(day.date)}
                        onClick={() =>
                          onSelect(
                            selectedDate === day.date ? undefined : day.date,
                          )
                        }
                        onKeyDown={(event) => {
                          const offset = (
                            {
                              ArrowUp: -1,
                              ArrowDown: 1,
                              ArrowLeft: -7,
                              ArrowRight: 7,
                            } as Record<string, number>
                          )[event.key]
                          const targetIndex =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? days.length - 1
                                : offset === undefined
                                  ? undefined
                                  : Math.max(
                                      0,
                                      Math.min(days.length - 1, index + offset),
                                    )
                          if (targetIndex === undefined) return
                          event.preventDefault()
                          const target = event.currentTarget
                            .closest("fieldset")
                            ?.querySelectorAll("button")[targetIndex]
                          target?.focus()
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent
                      className="usage-calendar-tooltip"
                      sideOffset={8}
                    >
                      <span>{fullDate.format(date)}</span>
                      <strong>{exact.format(tokens)} tokens</strong>
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </fieldset>
          </TooltipProvider>
          <div className="usage-calendar-months" aria-hidden="true">
            {months.map(({ date, column }) => (
              <span
                key={date}
                style={{
                  gridColumn: `${column} / span ${Math.min(3, columns - column + 1)}`,
                }}
              >
                {month.format(new Date(`${date}T00:00:00Z`))}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
