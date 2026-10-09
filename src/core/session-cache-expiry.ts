import type { SessionCacheExpiry } from "../protocol/session-cache-expiry.ts"

export type { SessionCacheExpiry } from "../protocol/session-cache-expiry.ts"

import type { StoredRolloutItem } from "./rollout.ts"

/**
 * The last completed turn owns the cache policy: the Session's currently
 * selected model can differ from the model that sent the last request.
 */
export function sessionCacheExpiry(
  rollout: readonly StoredRolloutItem[],
): SessionCacheExpiry | undefined {
  let lastCompletion: StoredRolloutItem | undefined
  for (let index = rollout.length - 1; index >= 0; index -= 1) {
    const record = rollout[index]
    if (
      record?.item.type === "turn_completed" &&
      record.item.outcome === "completed"
    ) {
      lastCompletion = record
      break
    }
  }
  if (lastCompletion?.item.type !== "turn_completed") return undefined
  let context: StoredRolloutItem | undefined
  for (let index = rollout.length - 1; index >= 0; index -= 1) {
    const record = rollout[index]
    if (
      record !== undefined &&
      record.seq < lastCompletion.seq &&
      record.item.type === "turn_context" &&
      record.item.context.turnId === lastCompletion.item.turnId
    ) {
      context = record
      break
    }
  }
  if (context?.item.type !== "turn_context") return undefined

  const { provider, model } = context.item.context.selection
  const lastTurnCompletedAt = lastCompletion.createdAt
  const lastRequestStartedAt = lastCompletion.item.lastRequestStartedAt
  const startedMs =
    lastRequestStartedAt === undefined
      ? Number.NaN
      : Date.parse(lastRequestStartedAt)
  // This is captured just before stream invocation; the provider's actual
  // request starts slightly later and its cache retention is not guaranteed.
  const withWindow = (minutes: number) =>
    Number.isFinite(startedMs)
      ? { expiresAt: new Date(startedMs + minutes * 60_000).toISOString() }
      : {}

  if (provider === "anthropic") {
    // Yakitori sends ephemeral cache breakpoints without an explicit TTL.
    return {
      provider,
      lastTurnCompletedAt,
      ...(lastRequestStartedAt === undefined ? {} : { lastRequestStartedAt }),
      ttlDescription:
        lastRequestStartedAt === undefined
          ? "5-minute cache; last provider request time unavailable"
          : "5 minutes after last use",
      status: lastRequestStartedAt === undefined ? "unknown" : "estimated",
      ...withWindow(5),
    }
  }
  if (
    provider === "openai" &&
    /^gpt-(?:[6-9](?:[.-]|$)|5\.(?:[6-9]|\d{2,})(?:[.-]|$))/.test(model)
  ) {
    // GPT-5.6+ has a minimum retention policy; an entry can outlive it.
    return {
      provider,
      lastTurnCompletedAt,
      ...(lastRequestStartedAt === undefined ? {} : { lastRequestStartedAt }),
      ttlDescription:
        lastRequestStartedAt === undefined
          ? "At least 30-minute retention; last provider request time unavailable"
          : "At least 30 minutes after last use",
      status: lastRequestStartedAt === undefined ? "unknown" : "minimum",
      ...withWindow(30),
    }
  }
  const ttlDescription =
    provider === "openai"
      ? "Retention varies by model and organization"
      : provider === "grok"
        ? "Cache may be evicted at any time"
        : provider === "kimi"
          ? "Cache lifetime managed by provider"
          : "Cache lifetime unknown"
  return {
    provider,
    lastTurnCompletedAt,
    ...(lastRequestStartedAt === undefined ? {} : { lastRequestStartedAt }),
    ttlDescription,
    status: "unknown",
  }
}
