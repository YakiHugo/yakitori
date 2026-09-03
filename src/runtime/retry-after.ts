// HTTP Retry-After is either seconds or an HTTP date. Some provider APIs also
// expose the more precise retry-after-ms extension.
const MAX_RETRY_AFTER_MS = 120_000

export function parseRetryAfterMs(
  headers: Headers | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (headers === undefined) return undefined
  const milliseconds = parseNonNegativeNumber(headers.get("retry-after-ms"))
  if (milliseconds !== undefined) return cap(milliseconds)

  const retryAfter = headers.get("retry-after")?.trim()
  if (retryAfter === undefined || retryAfter.length === 0) return undefined
  const seconds = parseNonNegativeNumber(retryAfter)
  if (seconds !== undefined) return cap(seconds * 1_000)
  if (Number.isFinite(Number(retryAfter))) return undefined
  const at = Date.parse(retryAfter)
  if (Number.isNaN(at)) return undefined
  return cap(Math.max(0, at - nowMs))
}

function cap(milliseconds: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(milliseconds))
}

function parseNonNegativeNumber(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
