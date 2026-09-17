import { describe, expect, it, vi } from "vitest"
import {
  parseCodexUsage,
  readCodexUsage,
} from "../../src/runtime/codex-usage.ts"

describe("Codex subscription usage", () => {
  it("maps primary, secondary, and additional quota windows", () => {
    expect(
      parseCodexUsage({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18_000,
            reset_at: 2_000_000_000,
          },
          secondary_window: {
            used_percent: 68,
            limit_window_seconds: 604_800,
            reset_at: 2_000_100_000,
          },
        },
        additional_rate_limits: [
          {
            limit_name: "Review",
            rate_limit: {
              primary_window: {
                used_percent: 9,
                limit_window_seconds: 3_600,
                reset_at: 2_000_200_000,
              },
            },
          },
        ],
      }),
    ).toEqual({
      plan: "pro",
      buckets: [
        {
          name: "Codex · 5-hour limit",
          usedPercent: 42,
          resetsAt: 2_000_000_000_000,
        },
        {
          name: "Codex · Weekly limit",
          usedPercent: 68,
          resetsAt: 2_000_100_000_000,
        },
        {
          name: "Review · 1-hour limit",
          usedPercent: 9,
          resetsAt: 2_000_200_000_000,
        },
      ],
    })
  })

  it("sends the active account identity without exposing credentials", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 18_000,
              reset_at: 2_000_000_000,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    await expect(
      readCodexUsage({
        fetchFn,
        resolveAccessToken: async () => ({
          accessToken: "secret-token",
          accountId: "account-1",
        }),
      }),
    ).resolves.toMatchObject({ plan: "plus" })

    expect(fetchFn).toHaveBeenCalledOnce()
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/wham/usage",
    )
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer secret-token",
        "ChatGPT-Account-Id": "account-1",
      },
    })
  })

  it("rejects non-success responses without including their body", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("private backend detail", { status: 403 }),
      )

    await expect(
      readCodexUsage({
        fetchFn,
        resolveAccessToken: async () => ({
          accessToken: "secret-token",
          accountId: undefined,
        }),
      }),
    ).rejects.toThrow("Codex usage request failed with status 403.")
  })

  it("clamps overage and drops reset timestamps outside the Date range", () => {
    expect(
      parseCodexUsage({
        rate_limit: {
          primary_window: {
            used_percent: 125,
            limit_window_seconds: 18_000,
            reset_at: 9_000_000_000_000,
          },
        },
      }),
    ).toEqual({
      buckets: [
        {
          name: "Codex · 5-hour limit",
          usedPercent: 100,
        },
      ],
    })
  })
})
