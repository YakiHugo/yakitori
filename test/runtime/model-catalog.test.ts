import { describe, expect, it } from "vitest"
import {
  createSessionExecutionPolicy,
  deriveCompactionContextBytes,
  deriveModelVisibleContextBytes,
} from "../../src/runtime/limits.ts"
import {
  catalogContextWindowTokens,
  catalogModelCapacity,
  resolveModel,
  validateModelSelection,
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

  it("uses the local coding-agent capacities for Grok and Kimi", () => {
    expect(
      catalogContextWindowTokens({ provider: "grok", model: "grok-4.6" }),
    ).toBe(500_000)
    expect(catalogContextWindowTokens({ provider: "kimi", model: "k3" })).toBe(
      1_048_576,
    )
    expect(
      catalogContextWindowTokens({
        provider: "kimi",
        model: "kimi-for-coding",
      }),
    ).toBe(262_144)
  })

  it("validates the explicit Grok effort sets without inference", () => {
    expect(() =>
      validateModelSelection({
        provider: "grok",
        model: "grok-4.6",
        effort: "xhigh",
      }),
    ).not.toThrow()
    expect(() =>
      validateModelSelection({
        provider: "grok",
        model: "grok-4.5",
        effort: "xhigh",
      }),
    ).toThrow("Reasoning effort xhigh is not supported by grok/grok-4.5.")
  })

  it("binds known profiles explicitly without guessing unknown models", () => {
    expect(resolveModel({ provider: "codex", model: "gpt-5.6-sol" })).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      instructionProfileId: "codex",
    })
    expect(resolveModel({ provider: "grok", model: "grok-4.6" })).toEqual({
      provider: "grok",
      model: "grok-4.6",
      instructionProfileId: "grok",
    })
    expect(resolveModel({ provider: "codex", model: "gpt-future" })).toEqual({
      provider: "codex",
      model: "gpt-future",
      instructionProfileId: "default",
    })
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
