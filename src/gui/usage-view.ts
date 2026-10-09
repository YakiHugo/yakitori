import type {
  ModelUsage,
  ThreadUsageSummary,
  UsageTokenTotals,
} from "../protocol/usage.ts"

export type UsageRange = 7 | 30 | 90 | 366 | "all"
export const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  turns: 0,
}

export function usageCalendar(summary: ThreadUsageSummary, count: number) {
  const last = new Date(summary.generatedAt)
  last.setUTCHours(0, 0, 0, 0)
  const days = new Map(summary.days.map((day) => [day.date, day]))
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(last)
    date.setUTCDate(date.getUTCDate() - count + 1 + index)
    const key = date.toISOString().slice(0, 10)
    return days.get(key) ?? { ...emptyUsage, date: key }
  })
}

export function usageView(
  summary: ThreadUsageSummary,
  range: UsageRange,
  date?: string,
) {
  const days = usageCalendar(summary, range === "all" ? 30 : range)
  if (range === "all" && date === undefined)
    return { totals: summary.totals, models: summary.models, days }
  const selectedDays =
    date === undefined ? days : days.filter((day) => day.date === date)
  const dates = new Set(selectedDays.map((day) => day.date))
  const totals = selectedDays.reduce(addUsage, { ...emptyUsage })
  const models = new Map<string, ModelUsage>()
  for (const row of summary.modelDays) {
    if (!dates.has(row.date)) continue
    const key = JSON.stringify([row.provider, row.model])
    models.set(key, {
      provider: row.provider,
      model: row.model,
      ...addUsage(models.get(key) ?? emptyUsage, row),
    })
  }
  return {
    totals,
    models: [...models.values()].sort(
      (a, b) =>
        totalTokens(b) - totalTokens(a) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    ),
    days,
  }
}

export function totalTokens(usage: UsageTokenTotals) {
  // Provider adapters normalize cached input into inputTokens already.
  return usage.inputTokens + usage.outputTokens
}

function addUsage(a: typeof emptyUsage, b: typeof emptyUsage) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    turns: a.turns + b.turns,
  }
}
