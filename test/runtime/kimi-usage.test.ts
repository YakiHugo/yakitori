import { describe, expect, it, vi } from "vitest"
import { parseKimiUsage, readKimiUsage } from "../../src/runtime/kimi-usage.ts"

describe("Kimi subscription usage", () => {
  it("maps the weekly summary and rolling quota windows", () => {
    expect(
      parseKimiUsage({
        usage: {
          used: "35",
          limit: "100",
          resetTime: "2026-09-18T04:09:10.001233Z",
        },
        limits: [
          {
            window: {
              duration: 300,
              timeUnit: "TIME_UNIT_MINUTE",
            },
            detail: {
              used: "12",
              limit: "100",
              resetTime: "2026-09-17T06:09:10.001233Z",
            },
          },
        ],
      }),
    ).toEqual({
      buckets: [
        {
          name: "Kimi · Weekly limit",
          usedPercent: 35,
          resetsAt: Date.parse("2026-09-18T04:09:10.001233Z"),
        },
        {
          name: "Kimi · 5-hour limit",
          usedPercent: 12,
          resetsAt: Date.parse("2026-09-17T06:09:10.001233Z"),
        },
      ],
    })
  })

  it("treats an omitted used value as zero and rejects invalid limits", () => {
    expect(
      parseKimiUsage({
        usage: { used: "1", limit: "0" },
        limits: [
          {
            window: {
              duration: 300,
              timeUnit: "TIME_UNIT_MINUTE",
            },
            detail: { limit: "100", resetTime: "not-a-date" },
          },
        ],
      }),
    ).toEqual({
      buckets: [{ name: "Kimi · 5-hour limit", usedPercent: 0 }],
    })
  })

  it("uses the Kimi Code account endpoint without spoofed client headers", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        usage: { used: "1", limit: "10" },
      }),
    )

    await readKimiUsage("secret-key", { fetchFn })

    expect(fetchFn).toHaveBeenCalledOnce()
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://api.kimi.com/coding/v1/usages",
    )
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer secret-key",
        Accept: "application/json",
      },
    })
    const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers)
    expect(headers.get("user-agent")).toBeNull()
  })

  it("does not expose a failed response body", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private detail", { status: 403 }))
    await expect(readKimiUsage("secret-key", { fetchFn })).rejects.toThrow(
      "Kimi usage request failed with status 403.",
    )
  })
})
