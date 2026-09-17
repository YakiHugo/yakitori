import { resolveCodexAccessToken } from "./codex-credentials.ts"

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const USAGE_REQUEST_TIMEOUT_MS = 15_000

export type CodexUsageBucket = Readonly<{
  name: string
  usedPercent: number
  resetsAt?: number
}>

export type CodexUsageSnapshot = Readonly<{
  plan?: string
  buckets: readonly CodexUsageBucket[]
}>

export async function readCodexUsage(
  input: {
    readonly fetchFn?: typeof fetch
    readonly resolveAccessToken?: typeof resolveCodexAccessToken
    readonly signal?: AbortSignal
  } = {},
): Promise<CodexUsageSnapshot> {
  const token = await (input.resolveAccessToken ?? resolveCodexAccessToken)()
  const response = await (input.fetchFn ?? fetch)(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      ...(token.accountId === undefined
        ? {}
        : { "ChatGPT-Account-Id": token.accountId }),
    },
    signal: input.signal ?? AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `Codex usage request failed with status ${response.status}.`,
    )
  }
  return parseCodexUsage(await response.json())
}

export function parseCodexUsage(value: unknown): CodexUsageSnapshot {
  if (!isRecord(value)) throw new Error("Codex usage response is malformed.")

  const plan = nonEmptyString(value.plan_type)
  const buckets = [
    ...parseLimitWindows(value.rate_limit, "Codex"),
    ...(Array.isArray(value.additional_rate_limits)
      ? value.additional_rate_limits.flatMap((entry) => {
          if (!isRecord(entry)) return []
          const label =
            nonEmptyString(entry.limit_name) ??
            nonEmptyString(entry.metered_feature) ??
            "Additional usage"
          return parseLimitWindows(entry.rate_limit, label)
        })
      : []),
  ]
  return {
    ...(plan === undefined ? {} : { plan }),
    buckets,
  }
}

function parseLimitWindows(value: unknown, label: string): CodexUsageBucket[] {
  if (!isRecord(value)) return []
  return [
    parseWindow(value.primary_window, label),
    parseWindow(value.secondary_window, label),
  ].flatMap((bucket) => (bucket === undefined ? [] : [bucket]))
}

function parseWindow(
  value: unknown,
  label: string,
): CodexUsageBucket | undefined {
  if (!isRecord(value)) return
  const usedPercent = value.used_percent
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0
  ) {
    return
  }
  const windowSeconds = positiveNumber(value.limit_window_seconds)
  const resetsAt = timestampMilliseconds(value.reset_at)
  return {
    name:
      windowSeconds === undefined
        ? `${label} limit`
        : `${label} · ${formatWindow(windowSeconds)}`,
    usedPercent: Math.min(100, usedPercent),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

function formatWindow(seconds: number): string {
  const days = seconds / 86_400
  if (Number.isInteger(days) && days >= 1)
    return days === 7 ? "Weekly limit" : `${days}-day limit`
  const hours = seconds / 3_600
  if (Number.isInteger(hours) && hours >= 1) return `${hours}-hour limit`
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `${minutes}-minute limit`
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function timestampMilliseconds(value: unknown): number | undefined {
  const seconds = positiveNumber(value)
  if (seconds === undefined) return
  const milliseconds = seconds * 1_000
  return Number.isFinite(new Date(milliseconds).getTime())
    ? milliseconds
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
