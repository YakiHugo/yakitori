import { afterEach, expect, it, vi } from "vitest"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

afterEach(() => vi.unstubAllGlobals())

it("preserves native directory order for default selection rather than applying display sorting", async () => {
  const models = [
    "my-model-2",
    "my-model-10-2025-04-01",
    "my-model-10",
    "my-model-10-2025-06-01",
  ]
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: models.map((id) => ({ id })) })),
    )
  vi.stubGlobal("fetch", fetch)
  const discovered = await discoverProviderModels(
    {
      name: "Custom",
      wireApi: "openai_chat_completions",
      baseURL: "https://custom.example/v1",
      models: [],
    },
    undefined,
  )
  expect(discovered.map((model) => model.id)).toEqual([
    "my-model-2",
    "my-model-10-2025-04-01",
    "my-model-10",
    "my-model-10-2025-06-01",
  ])
})
