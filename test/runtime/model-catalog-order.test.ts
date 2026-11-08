import { expect, it } from "vitest"
import type { ConfiguredModel } from "../../src/protocol/providers.ts"
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

it("retains preset family priority without detaching unlisted snapshots", () => {
  const models = [
    "gpt-4o",
    "claude-sonnet-4",
    "gpt-4o-2024-08-06",
    "gpt-5",
    "gpt-5-2025-08-07",
    "custom-chat",
  ].map((id) => ({ id }))
  expect(
    ids(sortModelCatalog(models, ["gpt-5", "claude-sonnet-4", "gpt-4o"])),
  ).toEqual([
    "gpt-5",
    "gpt-5-2025-08-07",
    "gpt-4o",
    "gpt-4o-2024-08-06",
    "claude-sonnet-4",
    "custom-chat",
  ])
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

it("organizes explicit purposes without treating unknown models as non-chat", () => {
  const models: ConfiguredModel[] = [
    { id: "a-video", kind: "video" },
    { id: "a-image", kind: "image" },
    { id: "a-other", kind: "other" },
    { id: "z-private" },
    { id: "b-chat", kind: "chat" },
  ]
  expect(ids(sortModelCatalog(models))).toEqual([
    "b-chat",
    "z-private",
    "a-image",
    "a-video",
    "a-other",
  ])
})

it("orders multi-component versions numerically within a family", () => {
  const models = [
    "gpt-5.2",
    "gpt-4o",
    "gpt-5.10",
    "gpt-5.2-mini",
    "gpt-5.2-2025-12-11",
  ].map((id) => ({ id }))
  expect(ids(sortModelCatalog(models))).toEqual([
    "gpt-5.10",
    "gpt-5.2",
    "gpt-5.2-2025-12-11",
    "gpt-5.2-mini",
    "gpt-4o",
  ])
})
