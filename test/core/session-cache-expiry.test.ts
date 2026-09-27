import { describe, expect, it } from "vitest"
import type { StoredRolloutItem } from "../../src/core/rollout.ts"
import { sessionCacheExpiry } from "../../src/core/session-cache-expiry.ts"

function context(
  seq: number,
  turnId: string,
  provider: string,
  model: string,
): StoredRolloutItem {
  return {
    threadId: "session_test",
    rolloutId: "rollout_test",
    seq,
    createdAt: "2026-09-20T10:00:00.000Z",
    item: {
      type: "turn_context",
      context: {
        turnId,
        selection: { provider, model },
        configuration: {} as never,
      },
    },
  }
}

function completion(
  seq: number,
  turnId: string,
  createdAt: string,
  outcome: "completed" | "failed" = "completed",
  lastRequestStartedAt?: string,
): StoredRolloutItem {
  return {
    threadId: "session_test",
    rolloutId: "rollout_test",
    seq,
    createdAt,
    item: {
      type: "turn_completed",
      turnId,
      outcome,
      ...(lastRequestStartedAt === undefined ? {} : { lastRequestStartedAt }),
    },
  }
}

describe("session cache expiry", () => {
  it("uses the last request start even when streaming delays completion and the model changes", () => {
    const lastTurnCompletedAt = "2026-09-20T10:07:30.000Z"
    const lastRequestStartedAt = "2026-09-20T10:00:00.000Z"
    expect(
      sessionCacheExpiry([
        context(1, "turn_one", "anthropic", "claude-sonnet-4-6"),
        completion(
          2,
          "turn_one",
          lastTurnCompletedAt,
          "completed",
          lastRequestStartedAt,
        ),
        context(3, "turn_two", "grok", "grok-4.7"),
      ]),
    ).toEqual({
      provider: "anthropic",
      lastTurnCompletedAt,
      lastRequestStartedAt,
      ttlDescription: "5 minutes after last use",
      expiresAt: "2026-09-20T10:05:00.000Z",
      status: "estimated",
    })
  })

  it("exposes newer OpenAI's minimum lifetime without asserting a hard expiry", () => {
    expect(
      sessionCacheExpiry([
        context(1, "turn_one", "openai", "gpt-6-sol"),
        completion(
          2,
          "turn_one",
          "2026-09-20T10:00:30.000Z",
          "completed",
          "2026-09-20T10:00:00.000Z",
        ),
      ]),
    ).toEqual({
      provider: "openai",
      lastTurnCompletedAt: "2026-09-20T10:00:30.000Z",
      lastRequestStartedAt: "2026-09-20T10:00:00.000Z",
      ttlDescription: "At least 30 minutes after last use",
      expiresAt: "2026-09-20T10:30:00.000Z",
      status: "minimum",
    })
  })

  it.each([
    ["openai", "gpt-5.5", "Retention varies by model and organization"],
    ["codex", "gpt-6-sol", "Cache lifetime unknown"],
    ["grok", "grok-4.7", "Cache may be evicted at any time"],
    ["kimi", "kimi-k2", "Cache lifetime managed by provider"],
  ])("reports %s %s as unknown without inventing a timestamp", (provider, model, ttlDescription) => {
    expect(
      sessionCacheExpiry([
        context(1, "turn_one", provider, model),
        completion(2, "turn_one", "2026-09-20T10:00:30.000Z"),
      ]),
    ).toEqual({
      provider,
      lastTurnCompletedAt: "2026-09-20T10:00:30.000Z",
      ttlDescription,
      status: "unknown",
    })
  })

  it("does not infer an expiry from a failed or unfinished turn", () => {
    expect(
      sessionCacheExpiry([context(1, "turn_one", "anthropic", "claude")]),
    ).toBeUndefined()
    expect(
      sessionCacheExpiry([
        context(1, "turn_one", "anthropic", "claude"),
        completion(2, "turn_one", "2026-09-20T10:00:30.000Z", "failed"),
      ]),
    ).toBeUndefined()
  })

  it.each([
    [
      "anthropic",
      "claude-sonnet-4-6",
      "5-minute cache; last provider request time unavailable",
    ],
    [
      "openai",
      "gpt-6-sol",
      "At least 30-minute retention; last provider request time unavailable",
    ],
  ])("leaves %s completion-only rollout expiry unknown", (provider, model, ttlDescription) => {
    expect(
      sessionCacheExpiry([
        context(1, "turn_one", provider, model),
        completion(2, "turn_one", "2026-09-20T10:07:30.000Z"),
      ]),
    ).toEqual({
      provider,
      lastTurnCompletedAt: "2026-09-20T10:07:30.000Z",
      ttlDescription,
      status: "unknown",
    })
  })
})
