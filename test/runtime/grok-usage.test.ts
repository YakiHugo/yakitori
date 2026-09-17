import { describe, expect, it, vi } from "vitest"
import { parseGrokUsage, readGrokUsage } from "../../src/runtime/grok-usage.ts"

describe("Grok subscription usage", () => {
  it("maps the current credits period and subscription tier", () => {
    expect(
      parseGrokUsage({
        subscriptionTier: "SuperGrok Heavy",
        config: {
          creditUsagePercent: 42.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-14T00:00:00Z",
            end: "2026-09-21T00:00:00Z",
          },
        },
      }),
    ).toEqual({
      plan: "SuperGrok Heavy",
      buckets: [
        {
          name: "Grok · Weekly limit",
          usedPercent: 42.5,
          resetsAt: Date.parse("2026-09-21T00:00:00Z"),
        },
      ],
    })
  })

  it("supports the legacy monthly credit shape and clamps overage", () => {
    expect(
      parseGrokUsage({
        config: {
          monthlyLimit: { val: 2_000 },
          used: { val: 2_500 },
          billingPeriodEnd: "2026-10-01T00:00:00Z",
        },
      }),
    ).toEqual({
      buckets: [
        {
          name: "Grok · Billing period",
          usedPercent: 100,
          resetsAt: Date.parse("2026-10-01T00:00:00Z"),
        },
      ],
    })
  })

  it("sends the OAuth billing identity and client headers", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        config: { creditUsagePercent: 12 },
      }),
    )

    await readGrokUsage({
      fetchFn,
      resolveCredentials: async () => ({
        accessToken: "secret-token",
        userId: "user-1",
        expiresAt: 2_000_000_000,
      }),
    })

    expect(fetchFn).toHaveBeenCalledOnce()
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    )
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer secret-token",
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-userid": "user-1",
        "x-grok-client-mode": "headless",
      },
    })
  })

  it("does not expose a failed response body", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private detail", { status: 403 }))
    await expect(
      readGrokUsage({
        fetchFn,
        resolveCredentials: async () => ({
          accessToken: "secret-token",
          userId: "user-1",
          expiresAt: 2_000_000_000,
        }),
      }),
    ).rejects.toThrow("Grok billing request failed with status 403.")
  })
})
