const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages"
const USAGE_REQUEST_TIMEOUT_MS = 8_000

export type KimiUsageSnapshot = Readonly<{
  buckets: readonly Readonly<{
    name: string
    usedPercent: number
    resetsAt?: number
  }>[]
}>

export async function readKimiUsage(
  apiKey: string,
  input: {
    readonly fetchFn?: typeof fetch
    readonly signal?: AbortSignal
  } = {},
): Promise<KimiUsageSnapshot> {
  const response = await (input.fetchFn ?? fetch)(KIMI_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: input.signal ?? AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Kimi usage request failed with status ${response.status}.`)
  }
  return parseKimiUsage(await response.json())
}

export function parseKimiUsage(value: unknown): KimiUsageSnapshot {
  if (!isRecord(value)) throw new Error("Kimi usage response is malformed.")
  const summary = parseUsageRow(value.usage, {
    duration: 1,
    unit: "week",
  })
  const limits = Array.isArray(value.limits)
    ? value.limits.flatMap((entry) => {
        if (!isRecord(entry)) return []
        const window = parseWindow(entry.window)
        const bucket = parseUsageRow(entry.detail, window, entry.name)
        return bucket === undefined ? [] : [bucket]
      })
    : []
  return {
    buckets: [...(summary === undefined ? [] : [summary]), ...limits],
  }
}

type UsageWindow = Readonly<{
  duration: number
  unit: "minute" | "hour" | "day" | "week"
}>

function parseUsageRow(
  value: unknown,
  window: UsageWindow | undefined,
  fallbackName?: unknown,
): KimiUsageSnapshot["buckets"][number] | undefined {
  if (!isRecord(value)) return
  const used = nonNegativeNumber(value.used) ?? 0
  const limit = nonNegativeNumber(value.limit)
  if (limit === undefined || limit <= 0) return
  const resetTimestamp = parseTimestamp(value.resetTime)
  return {
    name:
      window === undefined
        ? (nonEmptyString(fallbackName) ??
          nonEmptyString(value.name) ??
          "Kimi limit")
        : `Kimi · ${formatWindow(window)}`,
    usedPercent: Math.min(100, (used / limit) * 100),
    ...(resetTimestamp === undefined ? {} : { resetsAt: resetTimestamp }),
  }
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return
  const duration = positiveInteger(value.duration)
  const unit = parseTimeUnit(value.timeUnit)
  if (duration === undefined || unit === undefined) return
  if (unit === "minute" && duration >= 60 && duration % 60 === 0) {
    return { duration: duration / 60, unit: "hour" }
  }
  return { duration, unit }
}

function parseTimeUnit(value: unknown): UsageWindow["unit"] | undefined {
  switch (value) {
    case "TIME_UNIT_MINUTE":
      return "minute"
    case "TIME_UNIT_HOUR":
      return "hour"
    case "TIME_UNIT_DAY":
      return "day"
    case "TIME_UNIT_WEEK":
      return "week"
    default:
      return
  }
}

function formatWindow(window: UsageWindow): string {
  if (window.duration === 1 && window.unit === "week") return "Weekly limit"
  const units = {
    minute: "minute",
    hour: "hour",
    day: "day",
    week: "week",
  } as const
  return `${window.duration}-${units[window.unit]} limit`
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = nonNegativeNumber(value)
  return number !== undefined && Number.isInteger(number) && number > 0
    ? number
    : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
