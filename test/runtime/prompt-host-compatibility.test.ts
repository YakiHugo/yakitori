import { describe, expect, it } from "vitest"
import { getInstructionProfile } from "../../src/runtime/prompt-registry.ts"

describe("narrow prompt host adaptations", () => {
  it("describes both supported patch input forms without a command-array wrapper", () => {
    const text = getInstructionProfile("gpt-5").text
    expect(text).toContain("raw patch text for the freeform tool")
    expect(text).toContain("a JSON object with a `patch` string")
    expect(text).not.toContain('{"command":["apply_patch"')
  })

  it.each([
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "k3",
  ] as const)("grounds %s reminder authority in its source", (id) => {
    const text = getInstructionProfile(id).text
    expect(text).toContain("message role and source")
    expect(text).toContain("reference material")
    expect(text).not.toContain("Tags contain information from the system")
    expect(text).not.toContain(
      "is an authoritative directive from the harness; always follow it",
    )
  })

  it.each([
    "grok-4.5",
    "grok-4.6",
    "grok-4.7",
  ] as const)("lets %s observe command completion without assuming a push notification", (id) => {
    const text = getInstructionProfile(id).text
    expect(text).toContain("then continue independent work")
    expect(text).toContain("continue waiting as needed to observe completion")
    expect(text).toContain("avoid tight status polling")
    expect(text).not.toContain("one bounded wait")
  })

  it("preserves Codex model-specific parallel-calling guidance", () => {
    expect(getInstructionProfile("gpt-5.5").text).toContain(
      "`multi_tool_use.parallel` for that parallelism, and only that",
    )
    for (const id of ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"] as const) {
      expect(getInstructionProfile(id).text).toContain(
        "functions.exec using await Promise.allSettled",
      )
    }
  })
})
