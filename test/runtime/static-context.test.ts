import { describe, expect, it } from "vitest"
import {
  buildStaticContext,
  getPrompt,
  resolveModel,
} from "../../src/runtime/index.ts"

describe("model catalog", () => {
  it.each([
    ["openai", "gpt-5.6-sol", "gpt"],
    ["openai", "gpt-5.3-codex", "gpt"],
    ["openai", "gpt-4.1", "gpt"],
    ["openai", "o3", "gpt"],
    ["openai", "gpt-5.4", "gpt"],
    ["anthropic", "claude-opus-4-6", "anthropic"],
    ["google", "gemini-3-pro", "default"],
    ["kimi", "opaque-coding-model", "kimi"],
    ["opencode", "muse-spark-1", "default"],
    ["opencode", "trinity-large", "default"],
    ["codex", "gpt-9-future", "gpt"],
    ["faux", "scripted", "default"],
  ] as const)("maps %s/%s to %s", (provider, model, promptId) => {
    expect(resolveModel({ provider, model }).promptId).toBe(promptId)
  })

  it("loads complete, revisioned prompt resources", () => {
    const prompt = getPrompt("gpt")

    expect(prompt.text).toContain("# Tool and editing constraints")
    expect(prompt.revision).toMatch(/^[a-f0-9]{64}$/u)
  })

  it.each([
    ["default", "# Proactiveness"],
    ["anthropic", "# Professional objectivity"],
    ["gpt", "# Autonomy and persistence"],
    ["kimi", "# Prompt and tool use"],
  ] as const)("gives the %s family its reference-derived structure", (id, section) => {
    expect(getPrompt(id).text).toContain(section)
  })
})

describe("static context", () => {
  it("orders model, coding-agent, environment, and project context", () => {
    const context = buildStaticContext({
      environment: "<environment>workspace</environment>",
      mateInstructions: "Be concise.",
      mateRevisionId: "mate_revision_1",
      model: resolveModel({ provider: "openai", model: "gpt-5.6-sol" }),
      projectInstructions: {
        files: ["/workspace/AGENTS.md"],
        message: {
          role: "user",
          content: [{ type: "text", text: "Use focused tests." }],
        },
        truncated: false,
      },
    })

    expect(context.target).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
      promptId: "gpt",
    })
    expect(context.system.map((section) => section.id)).toEqual([
      "model.instructions",
      "agent.instructions",
      "environment",
    ])
    expect(context.system[1]).toEqual({
      id: "agent.instructions",
      revision: "mate_revision_1",
      text: "<agent_instructions>\nBe concise.\n</agent_instructions>",
    })
    expect(context.contextual[0]?.message.content[0]?.text).toBe(
      "Use focused tests.",
    )
  })

  it("omits empty coding-agent and project sections", () => {
    const context = buildStaticContext({
      environment: "<environment />",
      mateInstructions: "",
      mateRevisionId: "mate_revision_1",
      model: resolveModel({ provider: "faux", model: "scripted" }),
    })

    expect(context.system.map((section) => section.id)).toEqual([
      "model.instructions",
      "environment",
    ])
    expect(context.contextual).toEqual([])
  })
})
