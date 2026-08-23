import { describe, expect, it } from "vitest"
import type { InstructionProfileId } from "../../src/runtime/model-catalog.ts"
import { getInstructionProfile } from "../../src/runtime/prompt-registry.ts"

const promptIds = [
  "anthropic",
  "codex",
  "default",
  "grok",
  "kimi",
] as const satisfies readonly InstructionProfileId[]

describe("prompt registry", () => {
  it.each(promptIds)("loads and caches the bundled %s instructions", (id) => {
    const prompt = getInstructionProfile(id)

    expect(prompt).toEqual({
      id,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      text: expect.stringMatching(/\S/),
    })
    expect(getInstructionProfile(id)).toBe(prompt)
    expect(prompt.text).not.toContain("spawn_agent")
  })
})
