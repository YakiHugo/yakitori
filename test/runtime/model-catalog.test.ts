import { describe, expect, it } from "vitest"
import {
  catalogContextWindowTokens,
  deriveModelVisibleContextBytes,
} from "../../src/index.ts"

describe("model catalog context windows", () => {
  it("returns the curated window for known models", () => {
    expect(
      catalogContextWindowTokens({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    ).toBe(200_000)
  })

  it("is case-insensitive and misses unknown models", () => {
    expect(
      catalogContextWindowTokens({
        provider: "Anthropic",
        model: "CLAUDE-SONNET-4-6",
      }),
    ).toBe(200_000)
    expect(
      catalogContextWindowTokens({ provider: "faux", model: "scripted" }),
    ).toBeUndefined()
    expect(
      catalogContextWindowTokens({ provider: "openai", model: "gpt-5" }),
    ).toBeUndefined()
  })
})

describe("deriveModelVisibleContextBytes", () => {
  it("scales with the window and clamps to the band", () => {
    expect(deriveModelVisibleContextBytes(200_000)).toBe(600_000)
    expect(deriveModelVisibleContextBytes(1_000_000)).toBe(1024 * 1024)
    expect(deriveModelVisibleContextBytes(8_000)).toBe(128 * 1024)
  })
})
