import { describe, expect, it } from "vitest"
import catalog from "../../src/runtime/model-catalog.json" with { type: "json" }
import { requireInstructionProfileId } from "../../src/runtime/model-catalog.ts"
import manifest from "../../src/runtime/prompts/manifest.json" with {
  type: "json",
}
import { getInstructionProfile } from "../../src/runtime/prompt-registry.ts"

const officialAgents = {
  openai: "codex",
  codex: "codex",
  kimi: "kimi-code",
  grok: "grok-build",
  anthropic: "claude-code",
  faux: "yakitori",
}

describe("prompt registry", () => {
  it.each(
    catalog.models,
  )("binds $provider/$model to a versioned first-party prompt", (model) => {
    const id = requireInstructionProfileId(model.instructionProfileId)
    const prompt = getInstructionProfile(id)
    expect(id).toBe(model.provider === "faux" ? "default" : model.model)
    expect(manifest[id].agent).toBe(
      officialAgents[model.provider as keyof typeof officialAgents],
    )
    expect(prompt.revision).toBe(manifest[id].sha256)
    expect(getInstructionProfile(id)).toBe(prompt)
    expect(prompt.text).not.toMatch(
      /\$\{(?:\{|%|product_name|cwd)|\{\{ personality \}\}/,
    )
    expect(prompt.text).not.toMatch(/\/Users\/|\/tmp\/yakitori-/)
    expect(manifest[id].version).not.toBe("")
  })

  it("uses model-specific Claude Code bodies and an explicit shared Kimi profile", () => {
    expect(getInstructionProfile("claude-opus-4-6").text).toContain(
      "The exact model ID is claude-opus-4-6.",
    )
    expect(getInstructionProfile("claude-sonnet-4-6").text).toContain(
      "The exact model ID is claude-sonnet-4-6.",
    )
    expect(getInstructionProfile("claude-haiku-4-5").text).toContain(
      "The exact model ID is claude-haiku-4-5.",
    )
    expect(getInstructionProfile("k3").text).toBe(
      getInstructionProfile("kimi-for-coding").text,
    )
    expect(getInstructionProfile("grok-4.6").text).toContain(
      "You are Grok 4.6 released by xAI.",
    )
    expect(() => requireInstructionProfileId("codex")).toThrow(
      "Unknown instruction profile",
    )
    expect(() => requireInstructionProfileId("anthropic")).toThrow(
      "Unknown instruction profile",
    )
  })
})
