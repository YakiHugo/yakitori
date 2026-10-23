import { describe, expect, it } from "vitest"
import type { ModelSelection } from "../../src/kernel/events.ts"
import { resolveAgentModelTarget } from "../../src/runtime/agent-model-selection.ts"

describe("delegated model selection", () => {
  const inherited = {
    provider: "source-account",
    model: "shared",
    effort: "high",
    speed: "fast",
  }
  const catalog = {
    current: { provider: "source", model: "shared" },
    models: [
      {
        provider: "source",
        model: "shared",
        efforts: ["high", "low"],
        defaultEffort: "high",
      },
      {
        provider: "other",
        model: "shared",
        efforts: ["low", "medium"],
        defaultEffort: "low",
      },
    ],
    resolve: (selection: ModelSelection) => ({
      ...selection,
      provider: `${selection.provider}-account`,
    }),
  }

  it("treats a different provider with the same model name as a model change", () => {
    expect(
      resolveAgentModelTarget(inherited, { model: "other/shared" }, catalog),
    ).toEqual({ provider: "other", model: "shared", effort: "low" })
    expect(
      resolveAgentModelTarget(
        inherited,
        { model: "other/shared", reasoningEffort: "medium" },
        catalog,
      ),
    ).toEqual({ provider: "other", model: "shared", effort: "medium" })
  })

  it("uses the public current identity for effort-only selection and preserves its speed", () => {
    expect(
      resolveAgentModelTarget(inherited, { reasoningEffort: "low" }, catalog),
    ).toEqual({
      provider: "source",
      model: "shared",
      effort: "low",
      speed: "fast",
    })
    expect(resolveAgentModelTarget(inherited, {}, undefined)).toEqual(inherited)
  })

  it("validates the target account before returning a public model choice", () => {
    expect(() =>
      resolveAgentModelTarget(
        inherited,
        { model: "other/shared" },
        {
          ...catalog,
          resolve() {
            throw new Error("No connected account")
          },
        },
      ),
    ).toThrow("No connected account")
  })
})
