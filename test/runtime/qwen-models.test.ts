import { describe, expect, it } from "vitest"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { providerServices } from "../../src/runtime/provider-services.ts"
import { resolveProviderBackend } from "../../src/runtime/provider-backend.ts"
import { qwenEndpointPolicy } from "../../src/runtime/qwen-endpoints.ts"

const native = {
  service: "qwen",
  wireApi: "openai_chat_completions" as const,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
}

describe("Qwen Code preset models", () => {
  it("covers the official Qwen-owned union without inferring image input from names", async () => {
    const models = providerServices.find(
      (service) => service.id === "qwen",
    )?.models
    if (!models) throw new Error("Missing Qwen service")
    expect(models.map((model) => model.id).sort()).toEqual(
      [
        "qwen3.8-max",
        "qwen3.8-max-0902",
        "qwen3.8-flash",
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.6-plus",
        "qwen3.6-flash",
        "qwen3.5-plus",
        "qwen3-coder-plus",
        "qwen3-coder-next",
        "qwen3-max-2026-01-23",
      ].sort(),
    )
    const provider = createConfiguredProvider(
      "editable-account",
      {
        ...native,
        name: "Personal",
        models: models.map(({ id }) => ({ id })),
      },
      "unused",
    )
    try {
      for (const model of [
        "qwen3.8-max",
        "qwen3.8-max-0902",
        "qwen3.8-flash",
        "qwen3.7-plus",
        "qwen3.6-plus",
        "qwen3.6-flash",
        "qwen3.5-plus",
      ]) {
        const selection = { provider: "editable-account", model }
        expect(provider.models.resolve(selection)).toMatchObject({
          inputModalities: ["text", "image"],
          imageDetailModes: ["high"],
          supportsCustomTools: false,
          supportsNativeToolSearch: false,
          fileEditingToolType: "edit_write",
        })
        expect(provider.models.capacity(selection)?.contextWindowTokens).toBe(
          1_000_000,
        )
      }
      for (const [model, context] of [
        ["qwen3.7-max", 1_000_000],
        ["qwen3-coder-plus", 1_000_000],
        ["qwen3-coder-next", 262_144],
        ["qwen3-max-2026-01-23", 262_144],
      ] as const) {
        const selection = { provider: "editable-account", model }
        expect(provider.models.resolve(selection).inputModalities).toEqual([
          "text",
        ])
        expect(provider.models.capacity(selection)?.contextWindowTokens).toBe(
          context,
        )
      }
      expect(
        (await provider.models.listModels()).map((model) => model.model),
      ).not.toContain("qwen3-coder-plus")
      expect(
        await provider.models.listModels({ includeHidden: true }),
      ).toHaveLength(11)
    } finally {
      await provider.close?.()
    }
  })

  it.each([
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", 16 * 1024 * 1024],
    [
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/",
      16 * 1024 * 1024,
    ],
    ["https://dashscope-us.aliyuncs.com/compatible-mode/v1", 16 * 1024 * 1024],
    [
      "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
      16 * 1024 * 1024,
    ],
    ["https://coding.dashscope.aliyuncs.com/v1", 16 * 1024 * 1024],
    ["https://coding-intl.dashscope.aliyuncs.com/v1", 16 * 1024 * 1024],
    [
      "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      64_000_000,
    ],
    [
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      64_000_000,
    ],
    [
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      64_000_000,
    ],
    ["https://maas.qianwenaiapi.com/compatible-mode/v1", 64_000_000],
    ["https://maas.qwencloudapi.com/compatible-mode/v1", 64_000_000],
    ["https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1", 64_000_000],
    ["https://token-plan.maas.qwencloudapi.com/compatible-mode/v1", 64_000_000],
    [
      "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1",
      64_000_000,
    ],
  ])("recognizes only the documented budget for %s", (baseURL, requestBytes) => {
    expect(qwenEndpointPolicy(baseURL)?.requestBytes).toBe(requestBytes)
    expect(resolveProviderBackend({ ...native, baseURL }).serviceId).toBe(
      "qwen",
    )
  })

  it.each([
    "http://maas.qwencloudapi.com/compatible-mode/v1",
    "https://maas.qwencloudapi.com:444/compatible-mode/v1",
    "https://maas.qwencloudapi.com/compatible-mode/v1/other",
    "https://maas.qwencloudapi.com/compatible-mode/v1?relay=true",
    "https://maas.qwencloudapi.com/compatible-mode/v1#other",
    "https://user@maas.qwencloudapi.com/compatible-mode/v1",
    "https://maas.qwencloudapi.com.example/compatible-mode/v1",
    "https://foo.unknown.maas.aliyuncs.com/compatible-mode/v1",
    "https://nested.workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://relay.example/compatible-mode/v1",
  ])("does not grant native capabilities to %s", (baseURL) => {
    expect(qwenEndpointPolicy(baseURL)).toBeUndefined()
    expect(
      resolveProviderBackend({ ...native, baseURL }).serviceId,
    ).toBeUndefined()
  })
})
