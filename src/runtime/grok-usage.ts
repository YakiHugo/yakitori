import packageJson from "../../package.json" with { type: "json" }
import { resolveGrokCredentials } from "./grok-credentials.ts"

const GROK_BILLING_URL =
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
const BILLING_REQUEST_TIMEOUT_MS = 15_000

export type GrokUsageSnapshot = Readonly<{
  plan?: string
  buckets: readonly Readonly<{
    name: string
    usedPercent: number
    resetsAt?: number
  }>[]
}>

export async function readGrokUsage(
  input: {
    readonly fetchFn?: typeof fetch
    readonly resolveCredentials?: typeof resolveGrokCredentials
    readonly signal?: AbortSignal
  } = {},
): Promise<GrokUsageSnapshot> {
  const credentials = await (
    input.resolveCredentials ?? resolveGrokCredentials
  )()
  const response = await (input.fetchFn ?? fetch)(GROK_BILLING_URL, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-userid": credentials.userId,
      "x-grok-client-version": packageJson.version,
      "x-grok-client-mode": "headless",
    },
    signal: input.signal ?? AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `Grok billing request failed with status ${response.status}.`,
    )
  }
  return parseGrokUsage(await response.json())
}

export function parseGrokUsage(value: unknown): GrokUsageSnapshot {
  if (!isRecord(value)) throw new Error("Grok billing response is malformed.")
  const config = isRecord(value.config) ? value.config : undefined
  const plan =
    nonEmptyString(value.subscriptionTier) ??
    (config === undefined ? undefined : nonEmptyString(config.subscriptionTier))
  if (config === undefined) {
    return { ...(plan === undefined ? {} : { plan }), buckets: [] }
  }

  const reportedPercent = finiteNonNegative(config.creditUsagePercent)
  const monthlyLimit = centValue(config.monthlyLimit)
  const used = centValue(config.used)
  const derivedPercent =
    reportedPercent === undefined &&
    monthlyLimit !== undefined &&
    monthlyLimit > 0 &&
    used !== undefined
      ? (used / monthlyLimit) * 100
      : undefined
  const usedPercent = reportedPercent ?? derivedPercent
  if (usedPercent === undefined) {
    return { ...(plan === undefined ? {} : { plan }), buckets: [] }
  }

  const currentPeriod = isRecord(config.currentPeriod)
    ? config.currentPeriod
    : undefined
  const periodType =
    currentPeriod === undefined ? undefined : nonEmptyString(currentPeriod.type)
  const periodEnd =
    currentPeriod === undefined
      ? nonEmptyString(config.billingPeriodEnd)
      : (nonEmptyString(currentPeriod.end) ??
        nonEmptyString(config.billingPeriodEnd))
  const resetsAt = parseTimestamp(periodEnd)
  return {
    ...(plan === undefined ? {} : { plan }),
    buckets: [
      {
        name: `Grok · ${formatPeriod(periodType)}`,
        usedPercent: Math.min(100, usedPercent),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ],
  }
}

function formatPeriod(periodType: string | undefined): string {
  const normalized = periodType?.toUpperCase()
  if (normalized?.includes("WEEKLY")) return "Weekly limit"
  if (normalized?.includes("MONTHLY")) return "Monthly limit"
  return "Billing period"
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function centValue(value: unknown): number | undefined {
  if (!isRecord(value)) return
  return finiteNonNegative(value.val)
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
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
