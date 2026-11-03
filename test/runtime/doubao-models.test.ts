import { describe, expect, it } from "vitest"
import { providerServices } from "../../src/runtime/provider-services.ts"
import { resolveProviderBackend } from "../../src/runtime/provider-backend.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"

const native = {
  service: "doubao",
  wireApi: "openai_chat_completions" as const,
  baseURL: "https://ark.cn-beijing.volces.com/api/v3",
}

const models = [
  ["doubao-seed-evolving", 1_024_000, 256_000],
  ["doubao-seed-2-1-pro-260915", 1_048_576, 262_144],
  ["doubao-seed-2-1-turbo-260628", 256_000, 256_000],
] as const

describe("TRAE Seed models on standard Ark", () => {
  it("keeps exact visual model IDs and per-model capacities with function-tool fallback", async () => {
    expect(
      providerServices
        .find((service) => service.id === "doubao")
        ?.models.map((model) => model.id),
    ).toEqual(models.map(([id]) => id))
    const provider = createConfiguredProvider(
      "personal",
      {
        ...native,
        name: "Editable account",
        models: models.map(([id]) => ({ id })),
      },
      "unused",
    )
    try {
      for (const [model, contextWindowTokens, maxOutputTokens] of models) {
        const selection = { provider: "personal", model }
        expect(provider.models.resolve(selection)).toMatchObject({
          inputModalities: ["text", "image"],
          imageDetailModes: ["high"],
          maxOutputTokens,
          efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
          defaultEffort: "high",
          supportsCustomTools: false,
          supportsNativeToolSearch: false,
          fileEditingToolType: "edit_write",
        })
        expect(provider.models.capacity(selection)).toMatchObject({
          contextWindowTokens,
          contextWindowScope: "total",
        })
      }
    } finally {
      await provider.close?.()
    }
  })

  it.each([
    "https://relay.example/v1",
    "https://ark.cn-beijing.volces.com/api/coding/v3",
    "https://ark.cn-beijing.volces.com.evil.example/api/v3",
  ])("does not assign native capabilities to another endpoint: %s", async (baseURL) => {
    expect(
      resolveProviderBackend({ ...native, baseURL }).chatCompletionsFlavor,
    ).not.toBe("doubao")
    const provider = createConfiguredProvider(
      "personal",
      {
        ...native,
        baseURL,
        name: "Doubao",
        models: models.map(([id]) => ({ id })),
      },
      "unused",
    )
    try {
      for (const [model] of models) {
        expect(
          provider.models.resolve({ provider: "personal", model })
            .inputModalities,
        ).not.toContain("image")
      }
    } finally {
      await provider.close?.()
    }
  })

  it.each([
    "doubao-seed-evolving-latest",
    "doubao-seed-2-1-turbo",
    "doubao-seed-code",
  ])("does not infer visual capabilities for an undocumented ID: %s", async (model) => {
    const provider = createConfiguredProvider(
      "personal",
      { ...native, name: "Personal", models: [{ id: model }] },
      "unused",
    )
    try {
      expect(
        provider.models.resolve({ provider: "personal", model })
          .inputModalities,
      ).toEqual(["text"])
    } finally {
      await provider.close?.()
    }
  })
})
