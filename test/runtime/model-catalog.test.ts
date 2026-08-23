import { describe, expect, it } from "vitest"
import {
  createSessionExecutionPolicy,
  deriveCompactionContextBytes,
  deriveModelVisibleContextBytes,
} from "../../src/runtime/limits.ts"
import {
  catalogContextWindowTokens,
  catalogModelCapacity,
} from "../../src/runtime/model-catalog.ts"

describe("model catalog context windows", () => {
  it("returns the curated window for known models", () => {
    expect(
      catalogContextWindowTokens({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    ).toBe(200_000)
  })

  it("returns the Codex default, maximum, and effective window policy", () => {
    expect(
      catalogModelCapacity({ provider: "codex", model: "gpt-5.6-sol" }),
    ).toEqual({
      contextWindowTokens: 272_000,
      maxContextWindowTokens: 872_000,
      effectiveContextWindowPercent: 95,
    })
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
      catalogContextWindowTokens({
        provider: "codex",
        model: "gpt-5.6-sol",
      }),
    ).toBe(272_000)
    expect(
      catalogContextWindowTokens({ provider: "openai", model: "gpt-5" }),
    ).toBeUndefined()
  })
})

describe("deriveModelVisibleContextBytes", () => {
  it("keeps the full tokenizer-free capacity estimate", () => {
    expect(deriveModelVisibleContextBytes(200_000)).toBe(800_000)
    expect(deriveModelVisibleContextBytes(1_000_000)).toBe(4_000_000)
    expect(deriveModelVisibleContextBytes(8_000)).toBe(32_000)
  })
})

describe("compaction context baseline", () => {
  it("derives an 80% trigger and 16% verbatim tail by default", () => {
    const limits = createSessionExecutionPolicy()
    expect(
      deriveCompactionContextBytes({
        modelVisibleContextBytes: 1_000_000,
        triggerRatio: limits.compactionTriggerRatio,
        retainRatio: limits.compactionRetainRatio,
      }),
    ).toEqual({ triggerBytes: 800_000, retainBytes: 160_000 })
  })

  it("rejects a retention target that reaches the trigger", () => {
    expect(() =>
      createSessionExecutionPolicy({
        compactionTriggerRatio: 0.8,
        compactionRetainRatio: 0.8,
      }),
    ).toThrow("less than compactionTriggerRatio")
  })
})
