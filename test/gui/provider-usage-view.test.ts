import { expect, it } from "vitest"
import { estimateModelCost } from "../../src/gui/provider-usage-view.ts"
const usage = {
  provider: "work",
  model: "coder",
  inputTokens: 1_000_000,
  outputTokens: 200_000,
  cacheReadInputTokens: 400_000,
  cacheWriteInputTokens: 100_000,
  turns: 2,
}
it("prices cached input once and uses each documented rate", () => {
  expect(
    estimateModelCost(usage, {
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 3,
    }),
  ).toBe(3.5)
})
it("keeps absent model or cache rates unknown", () => {
  expect(estimateModelCost(usage, undefined)).toBeUndefined()
  expect(
    estimateModelCost(usage, { inputPerMillion: 2, outputPerMillion: 10 }),
  ).toBeUndefined()
  expect(
    estimateModelCost(
      { ...usage, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      { inputPerMillion: 2, outputPerMillion: 10 },
    ),
  ).toBe(4)
})
