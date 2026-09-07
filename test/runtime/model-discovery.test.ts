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

  it("reads OpenAI-compatible model ids for Grok and Kimi catalogs", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({ data: [{ id: "grok-4.6" }, { id: "future-model" }] }),
        { status: 200 },
      )

    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://api.x.ai/v1/",
        accessToken: "xai-token",
        fetchFn,
      }),
    ).resolves.toEqual([{ id: "grok-4.6" }, { id: "future-model" }])
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
      discover: async () => [{ id: "future-model", contextWindowTokens: 42_000 }],
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
