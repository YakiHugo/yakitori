import { afterEach, expect, it, vi } from "vitest"
import { resolveModel } from "../../src/runtime/model-catalog.ts"
import { openAIImageTokenEstimator } from "../../src/runtime/openai-image-budget.ts"
import { providerServices } from "../../src/runtime/provider-services.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"
import type { ProviderConfiguration } from "../../src/server/provider-configuration.ts"

afterEach(() => vi.restoreAllMocks())

// Public model pages verified 2026-11-03; these differ from Codex metadata.
it.each([
  "gpt-6.1-sol",
  "gpt-6.1-terra",
])("resolves native %s from ID-only discovery without borrowing Codex limits or image accounting", async (model) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [{ id: model }] })),
  )
  const configuration: ProviderConfiguration = {
    name: "OpenAI",
    service: "openai",
    baseURL: "https://api.openai.com/v1",
    wireApi: "openai_responses",
    models: [],
  }
  const models = await discoverProviderModels(configuration, "test")
  expect(models.map((entry) => entry.id)).toEqual([model])
  const provider = createConfiguredProvider(
    "personal",
    { ...configuration, models },
    "test",
  )
  const target = { provider: "personal", model }
  const info = provider.models.resolve(target)
  expect(info).toMatchObject({
    instructionProfileId: model,
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    defaultEffort: "medium",
    maxOutputTokens: 128000,
    supportsCustomTools: true,
    supportsNativeToolSearch: true,
    usedFallbackModelMetadata: false,
  })
  expect(provider.models.capacity(target)).toEqual({
    contextWindowTokens: 1050000,
    maxContextWindowTokens: 1050000,
    effectiveContextWindowPercent: 100,
    contextWindowScope: "total",
  })
  expect(info.efforts).toEqual(
    model.endsWith("terra")
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "xhigh", "max"],
  )
  expect(() =>
    provider.models.validate({ ...target, effort: "ultra" }),
  ).toThrow("not supported")
  expect(
    openAIImageTokenEstimator({
      serviceId: "openai",
      wireApi: "openai_responses",
      model: info,
    }),
  ).toBeUndefined()
  expect(resolveModel({ provider: "codex", model })).toMatchObject({
    defaultEffort: "low",
    imageDetailModes: ["high", "original"],
  })
  expect(
    providerServices
      .find((service) => service.id === "openai")
      ?.models.some((entry) => entry.id === model),
  ).toBe(true)
  await provider.close?.()
})

it("keeps relay model capabilities unverified and honors native explicit overrides", async () => {
  const model = "gpt-6.1-terra"
  const configuration: ProviderConfiguration = {
    name: "Custom",
    service: "openai",
    baseURL: "https://relay.example/v1",
    wireApi: "openai_responses",
    models: [{ id: model }],
  }
  const relay = createConfiguredProvider("personal", configuration, "test")
  expect(relay.models.resolve({ provider: "personal", model })).toMatchObject({
    usedFallbackModelMetadata: true,
    inputModalities: ["text"],
    imageDetailModes: [],
  })
  const native = createConfiguredProvider(
    "personal",
    {
      ...configuration,
      baseURL: "https://api.openai.com/v1",
      models: [
        {
          id: model,
          inputModalities: ["text"],
          imageDetailModes: [],
          contextWindowTokens: 200000,
          defaultEffort: "low",
        },
      ],
    },
    "test",
  )
  expect(native.models.resolve({ provider: "personal", model })).toMatchObject({
    inputModalities: ["text"],
    imageDetailModes: [],
    defaultEffort: "low",
  })
  expect(
    native.models.capacity({ provider: "personal", model })
      ?.contextWindowTokens,
  ).toBe(200000)
  await relay.close?.()
  await native.close?.()
})
