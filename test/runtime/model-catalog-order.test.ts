import { expect, it } from "vitest"
import { sortModelCatalog } from "../../src/protocol/model-catalog-order.ts"

const ids = (models: readonly { id: string }[]) =>
  models.map((model) => model.id)

it("keeps base aliases and newest-first snapshots together across catalog permutations", () => {
  const models = [
    "gpt-4o-mini",
    "gpt-4o-2024-05-13",
    "gpt-4o",
    "gpt-4o-2024-08-06",
    "claude-sonnet-4-20250514",
    "claude-sonnet-4",
    "gpt-4o-mini-2024-07-18",
  ].map((id) => ({ id }))
  const expected = [
    "claude-sonnet-4",
    "claude-sonnet-4-20250514",
    "gpt-4o",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-05-13",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
  ]
  expect(ids(sortModelCatalog(models))).toEqual(expected)
  expect(ids(sortModelCatalog([...models].reverse()))).toEqual(expected)
})

it("orders unknown versions naturally and retains exact custom IDs and settings", () => {
  const models = [
    "owner/custom-2",
    "owner/custom-10",
    "custom-0007",
    "custom-0008",
    "private deployment",
    "PRIVATE deployment",
  ].map((id, index) => ({
    id,
    visible: index % 2 === 0,
    displayName: "My model",
  }))
  const original = [...models]
  const sorted = sortModelCatalog(models)
  expect(ids(sorted)).toEqual([
    "custom-0008",
    "custom-0007",
    "owner/custom-10",
    "owner/custom-2",
    "PRIVATE deployment",
    "private deployment",
  ])
  expect(models).toEqual(original)
  for (const model of sorted)
    expect(model).toBe(models.find((entry) => entry.id === model.id))
})

it("orders each numeric version component rather than decimal or lexical values", () => {
  const models = [
    "gpt-5.9",
    "gpt-5.10",
    "gpt-6.1",
    "gpt-5.2-mini",
    "gpt-5.2",
  ].map((id) => ({ id }))
  expect(ids(sortModelCatalog(models))).toEqual([
    "gpt-6.1",
    "gpt-5.10",
    "gpt-5.9",
    "gpt-5.2",
    "gpt-5.2-mini",
  ])
})

it("compares full version numbers before variants and undotted base releases", () => {
  const models = [
    "gpt-5",
    "gpt-6-astra",
    "gpt-5-mini",
    "gpt-6.1-sol",
    "gpt-5.6-sol",
    "gpt-5.10",
    "gpt-5.9",
  ].map((id) => ({ id }))
  expect(ids(sortModelCatalog(models))).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-5.10",
    "gpt-5.9",
    "gpt-5.6-sol",
    "gpt-5",
    "gpt-5-mini",
  ])
})
