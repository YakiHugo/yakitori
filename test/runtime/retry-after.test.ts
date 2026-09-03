import { describe, expect, it } from "vitest"
import { parseRetryAfterMs } from "../../src/runtime/retry-after.ts"

describe("parseRetryAfterMs", () => {
  it("prefers provider millisecond precision", () => {
    expect(
      parseRetryAfterMs(
        new Headers({ "retry-after": "5", "retry-after-ms": "125.2" }),
      ),
    ).toBe(126)
  })

  it("parses standard seconds and HTTP dates", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1.5" }))).toBe(1_500)
    expect(
      parseRetryAfterMs(
        new Headers({ "retry-after": "Wed, 03 Sep 2026 00:00:02 GMT" }),
        Date.parse("2026-09-03T00:00:00.000Z"),
      ),
    ).toBe(2_000)
  })

  it("ignores invalid or negative values", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "-1" }))).toBe(
      undefined,
    )
    expect(parseRetryAfterMs(new Headers({ "retry-after": "later" }))).toBe(
      undefined,
    )
  })

  it("caps provider hints at the reference safety bound", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "600" }))).toBe(
      120_000,
    )
  })
})
