import { describe, expect, it, vi } from "vitest"
import {
  discoverCodexModels,
  discoverOpenAiCompatibleModels,
} from "../../src/runtime/model-discovery.ts"
import { createDiscoveringModelsManager } from "../../src/runtime/models-manager.ts"

describe("provider model discovery", () => {
  it("reads Codex capacity and compaction metadata from the authenticated catalog", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-discovered",
                display_name: "GPT Discovered",
                context_window: 300_000,
                max_context_window: 900_000,
                effective_context_window_percent: 95,
                auto_compact_token_limit: 250_000,
                compaction_hash: "compact-v2",
              },
            ],
          }),
          { status: 200 },
        ),
    )

    await expect(
      discoverCodexModels({
        baseUrl: "https://chatgpt.example/backend-api/codex/",
        accessToken: "access-token",
        accountId: "account-1",
        fetchFn,
      }),
    ).resolves.toEqual([
      {
        id: "gpt-discovered",
        displayName: "GPT Discovered",
        contextWindowTokens: 300_000,
        maxContextWindowTokens: 900_000,
        effectiveContextWindowPercent: 95,
        autoCompactTokenLimit: 250_000,
        compactionHash: "compact-v2",
      },
    ])
    expect(fetchFn).toHaveBeenCalledWith(
      "https://chatgpt.example/backend-api/codex/models?client_version=0.0.0",
      expect.objectContaining({
        headers: {
          authorization: "Bearer access-token",
          "chatgpt-account-id": "account-1",
        },
      }),
    )
  })

  it.each([
    {
      messages: { instructions_template: "Astra literal {{ personality }}" },
      expected: "Astra literal {{ personality }}",
    },
    {
      messages: {
        instructions_template: "Astra {{ personality }}",
        instructions_variables: { personality_default: "precise" },
      },
      expected: "Astra precise",
    },
    {
      messages: {
        instructions_template: "Astra {{ personality }}",
        instructions_variables: {},
      },
      expected: "Astra ",
    },
  ])("resolves each model's instruction template: $expected", async ({
    messages,
    expected,
  }) => {
    const models = await discoverCodexModels({
      baseUrl: "https://chatgpt.example/backend-api/codex",
      accessToken: "test",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            models: [
              { slug: "gpt-6-astra", model_messages: messages },
              {
                slug: "gpt-5.6-sol",
                model_messages: { instructions_template: "Sol instructions" },
              },
            ],
          }),
        ),
    })
    expect(models.map((model) => [model.id, model.instructions])).toEqual([
      ["gpt-6-astra", expected],
      ["gpt-5.6-sol", "Sol instructions"],
    ])
  })

  it("reads OpenAI-compatible model ids for Grok and Kimi catalogs", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({ data: [{ id: "grok-4.6" }, { id: "future-model" }] }),
        { status: 200 },
      )

    await expect(
      discoverOpenAiCompatibleModels({
        provider: "grok",
        baseUrl: "https://api.x.ai/v1/",
        accessToken: "xai-token",
        fetchFn,
      }),
    ).resolves.toEqual([{ id: "grok-4.6" }, { id: "future-model" }])
  })

  it("uses Kimi's returned capacities, modalities and effort levels throughout the model manager", async () => {
    const manager = createDiscoveringModelsManager({
      provider: "kimi",
      discover: () =>
        discoverOpenAiCompatibleModels({
          provider: "kimi",
          baseUrl: "https://kimi.example/v1",
          accessToken: "test",
          fetchFn: async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "k3",
                    display_name: "K3 account profile",
                    context_length: 262144,
                    supports_image_in: true,
                    supports_video_in: false,
                    think_efforts: {
                      support: true,
                      valid_efforts: ["low", "high"],
                    },
                  },
                ],
              }),
            ),
        }),
    })
    const models = await manager.listModels()
    expect(models[0]).toMatchObject({
      model: "k3",
      displayName: "K3 account profile",
      efforts: ["low", "high"],
      effortStyle: "levels",
      inputModalities: ["text", "image"],
    })
    expect(manager.resolve({ provider: "kimi", model: "k3" })).toMatchObject({
      instructionProfileId: "k3",
      inputModalities: ["text", "image"],
    })
    expect(manager.capacity({ provider: "kimi", model: "k3" })).toEqual({
      contextWindowTokens: 262144,
      maxContextWindowTokens: 262144,
      effectiveContextWindowPercent: 100,
    })
    expect(() =>
      manager.validate({ provider: "kimi", model: "k3", effort: "high" }),
    ).not.toThrow()
    expect(() =>
      manager.validate({ provider: "kimi", model: "k3", effort: "max" }),
    ).toThrow("not supported")
  })

  it("reads Grok context length without fabricating prompt or effort metadata", async () => {
    await expect(
      discoverOpenAiCompatibleModels({
        provider: "grok",
        baseUrl: "https://grok.example/v1",
        accessToken: "test",
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: "grok-4.6", context_length: 500000 },
                {
                  id: "invalid-metadata",
                  context_length: -1,
                  display_name: 42,
                },
              ],
            }),
          ),
      }),
    ).resolves.toEqual([
      { id: "grok-4.6", contextWindowTokens: 500000 },
      { id: "invalid-metadata" },
    ])
  })

  it("uses remote metadata while retaining the bundled catalog after discovery fails", async () => {
    let now = 0
    const discover = vi
      .fn<
        () => Promise<readonly [{ id: string; contextWindowTokens: number }]>
      >()
      .mockResolvedValueOnce([
        { id: "gpt-5.6-sol", contextWindowTokens: 333_000 },
      ])
      .mockRejectedValueOnce(new Error("offline"))
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      discover,
      now: () => now,
      ttlMs: 100,
    })

    expect((await manager.listModels())[0]?.model).toBe("gpt-5.6-sol")
    expect(
      manager.capacity({ provider: "codex", model: "gpt-5.6-sol" }),
    ).toMatchObject({ contextWindowTokens: 333_000 })

    now = 101
    const models = await manager.listModels()
    expect(discover).toHaveBeenCalledTimes(2)
    expect(models.some((model) => model.model === "gpt-5.6-sol")).toBe(true)
    expect(
      manager.capacity({ provider: "codex", model: "gpt-5.6-sol" }),
    ).toMatchObject({ contextWindowTokens: 333_000 })
  })

  it("keeps conservative capabilities for a discovered model without a bundled profile", async () => {
    const manager = createDiscoveringModelsManager({
      provider: "codex",
      discover: async () => [
        { id: "future-model", contextWindowTokens: 42_000 },
      ],
    })

    await manager.refresh()

    expect(
      manager.resolve({ provider: "codex", model: "future-model" }),
    ).toMatchObject({
      model: "future-model",
      usedFallbackModelMetadata: true,
    })
  })
})

it("advertises discovered coding models only with a bundled or provider-supplied instruction source", async () => {
  const grok = createDiscoveringModelsManager({
    provider: "grok",
    discover: async () => [
      { id: "grok-4.6" },
      { id: "grok-imagine-image" },
      { id: "unknown-model" },
    ],
  })
  expect((await grok.listModels()).map((model) => model.model)).toEqual([
    "grok-4.6",
    "grok-4.5",
  ])
  const codex = createDiscoveringModelsManager({
    provider: "codex",
    discover: async () => [
      {
        id: "gpt-new-coder",
        instructions: "Official new coding-agent instructions",
      },
    ],
  })
  expect((await codex.listModels())[0]?.model).toBe("gpt-new-coder")
  expect(
    codex.resolve({ provider: "codex", model: "gpt-new-coder" }).instructions,
  ).toBe("Official new coding-agent instructions")
})
