import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  createModelDirectory,
  directoryAllowlist,
} from "../../src/index.ts"

const modelsDevFixture = {
  openai: {
    id: "openai",
    models: {
      // Fixture order deliberately differs from the allowlist order.
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
      },
      "gpt-5.1-codex": {
        id: "gpt-5.1-codex",
        name: "GPT 5.1 Codex",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
      "gpt-image-1": {
        id: "gpt-image-1",
        name: "GPT Image 1",
        tool_call: true,
        modalities: { input: ["text"], output: ["image"] },
      },
      "text-embedding-3-large": {
        id: "text-embedding-3-large",
        name: "Text Embedding 3 Large",
        tool_call: false,
        modalities: { input: ["text"], output: ["text"] },
      },
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        tool_call: true,
        status: "deprecated",
        modalities: { input: ["text"], output: ["text"] },
      },
      "gpt-broken": "not-a-record",
    },
  },
}

const codexLiveFixture = {
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      visibility: "list",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
      service_tiers: [{ id: "priority", name: "Fast" }],
    },
    {
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      visibility: "hide",
      supported_reasoning_levels: [{ effort: "medium" }],
      service_tiers: [],
    },
    {
      slug: "gpt-5.2",
      display_name: "GPT-5.2",
      description: "Long-running agents.",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
      ],
      service_tiers: [],
    },
  ],
}

const anthropicLiveFixture = {
  data: [
    { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" },
  ],
}

const grokLiveFixture = {
  data: [
    { id: "grok-4.3" },
    { id: "grok-4.5" },
    { id: "grok-code-fast-1" },
  ],
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe("model directory", () => {
  it("serves openai from models.dev through the curated allowlist without speeds", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("models.dev")
      return jsonResponse(modelsDevFixture)
    }) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      disableDiskCache: true,
      resolveCodexAuth: async () => undefined,
      resolveGrokToken: async () => undefined,
      anthropicApiKey: () => undefined,
    })

    // Allowlist order wins; allowlisted ids absent from the directory drop out.
    // Speeds are omitted for public OpenAI (no per-entry service_tiers).
    expect(await directory.listModels("openai")).toEqual([
      {
        id: "gpt-5.1-codex",
        displayName: "GPT 5.1 Codex",
        efforts: ["low", "medium", "high"],
      },
      {
        id: "gpt-5",
        displayName: "GPT-5",
        efforts: ["low", "medium", "high"],
      },
    ])
  })

  it("maps codex live ModelInfo with visibility filter and full effort ladder", async () => {
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain("/models")
      expect(String(url)).toContain("client_version=")
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer tok",
        "chatgpt-account-id": "acct",
      })
      return jsonResponse(codexLiveFixture)
    }) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      disableDiskCache: true,
      resolveCodexAuth: async () => ({
        accessToken: "tok",
        accountId: "acct",
      }),
      clientVersion: "0.0.0",
    })

    expect(await directory.listModels("codex")).toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "low",
        speeds: ["standard", "priority"],
      },
      {
        id: "gpt-5.2",
        displayName: "GPT-5.2",
        description: "Long-running agents.",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
      },
    ])
  })

  it("gates anthropic efforts to opus/sonnet 4.6+ and omits haiku", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(anthropicLiveFixture),
    ) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      disableDiskCache: true,
      anthropicApiKey: "sk-ant-test",
    })

    // Allowlist order; sonnet-4-5 is not allowlisted and drops out.
    expect(await directory.listModels("anthropic")).toEqual([
      {
        id: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        efforts: ["low", "medium", "high"],
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        efforts: ["low", "medium", "high"],
      },
      {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
      },
    ])
  })

  it("filters grok live models through the allowlist", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("api.x.ai")
      return jsonResponse(grokLiveFixture)
    }) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      disableDiskCache: true,
      resolveGrokToken: async () => "grok-tok",
    })

    expect(await directory.listModels("grok")).toEqual([
      {
        id: "grok-4.5",
        displayName: "grok-4.5",
        efforts: ["low", "medium", "high"],
      },
      {
        id: "grok-4.3",
        displayName: "grok-4.3",
        efforts: ["low", "medium", "high"],
      },
    ])
  })

  it("exposes the allowlist as opt-in curation data", () => {
    expect(directoryAllowlist("openai")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.1-codex",
      "gpt-5",
    ])
    expect(directoryAllowlist("faux")).toBeUndefined()
    expect(directoryAllowlist("unknown")).toBeUndefined()
  })

  it("falls back to the bundled codex snapshot when live auth is missing", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("should not fetch")
    }) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      disableDiskCache: true,
      resolveCodexAuth: async () => undefined,
    })

    const models = await directory.listModels("codex")
    expect(fetchFn).not.toHaveBeenCalled()
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.2",
    ])
    expect(models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "low",
      speeds: ["standard", "priority"],
    })
  })

  it("falls back to curated openai entries when models.dev fails", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      disableDiskCache: true,
    })

    expect(await directory.listModels("openai")).toEqual([
      { id: "gpt-5.1-codex", displayName: "gpt-5.1-codex" },
      { id: "gpt-5", displayName: "gpt-5" },
    ])
  })

  it("falls back to curated openai for malformed models.dev payloads", async () => {
    for (const payload of [[], { openai: "junk" }, "nope"]) {
      const directory = createModelDirectory({
        fetchFn: vi.fn(async () =>
          jsonResponse(payload),
        ) as unknown as typeof fetch,
        disableDiskCache: true,
      })
      expect(await directory.listModels("openai")).toEqual([
        { id: "gpt-5.1-codex", displayName: "gpt-5.1-codex" },
        { id: "gpt-5", displayName: "gpt-5" },
      ])
    }
  })

  it("serves faux and kimi from the curated catalog without fetching", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("should not fetch")
    }) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      disableDiskCache: true,
    })

    expect(await directory.listModels("faux")).toEqual([
      { id: "scripted", displayName: "scripted" },
    ])
    expect(await directory.listModels("kimi")).toEqual([
      {
        id: "kimi-for-coding",
        displayName: "Kimi for Coding",
        efforts: ["on", "off"],
      },
      {
        id: "kimi-for-coding-highspeed",
        displayName: "Kimi for Coding HighSpeed",
        efforts: ["on", "off"],
      },
      {
        id: "k3",
        displayName: "Kimi K3",
        efforts: ["max"],
      },
    ])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("caches live results in memory for the TTL and refetches after it", async () => {
    let now = 1_000
    const fetchFn = vi.fn(async () =>
      jsonResponse(modelsDevFixture),
    ) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      now: () => now,
      ttlMs: 100,
      disableDiskCache: true,
    })

    await directory.listModels("openai")
    now = 1_050
    await directory.listModels("openai")
    expect(fetchFn).toHaveBeenCalledTimes(1)

    now = 1_200
    await directory.listModels("openai")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("serves the stale memory cache when a refresh after expiry fails", async () => {
    let now = 1_000
    let fail = false
    const fetchFn = vi.fn(async () => {
      if (fail) throw new Error("network down")
      return jsonResponse(modelsDevFixture)
    }) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      now: () => now,
      ttlMs: 100,
      disableDiskCache: true,
    })

    const fresh = await directory.listModels("openai")
    now = 1_200
    fail = true
    const stale = await directory.listModels("openai")
    expect(stale).toEqual(fresh)
  })

  it("persists live results to the disk cache and reuses a fresh disk entry", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakitori-catalog-"))
    const cachePath = join(cacheDir, "model-catalogs.json")
    const now = 1_000
    const fetchFn = vi.fn(async () =>
      jsonResponse(modelsDevFixture),
    ) as unknown as typeof fetch

    const first = createModelDirectory({
      fetchFn,
      now: () => now,
      ttlMs: 100,
      cachePath,
    })
    const models = await first.listModels("openai")
    expect(fetchFn).toHaveBeenCalledTimes(1)

    const onDisk = JSON.parse(await readFile(cachePath, "utf8")) as {
      providers: { openai: { fetchedAt: number; models: unknown[] } }
    }
    expect(onDisk.providers.openai.fetchedAt).toBe(1_000)
    expect(onDisk.providers.openai.models).toEqual(models)

    // New directory instance: memory empty, disk still fresh — no network.
    const second = createModelDirectory({
      fetchFn,
      now: () => now,
      ttlMs: 100,
      cachePath,
    })
    expect(await second.listModels("openai")).toEqual(models)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("falls back to a stale disk cache when live fails and memory is empty", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakitori-catalog-"))
    const cachePath = join(cacheDir, "model-catalogs.json")
    let now = 1_000
    const fetchFn = vi.fn(async () =>
      jsonResponse(modelsDevFixture),
    ) as unknown as typeof fetch

    const writer = createModelDirectory({
      fetchFn,
      now: () => now,
      ttlMs: 100,
      cachePath,
    })
    const models = await writer.listModels("openai")

    now = 10_000
    const failingFetch = vi.fn(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const reader = createModelDirectory({
      fetchFn: failingFetch,
      now: () => now,
      ttlMs: 100,
      cachePath,
    })
    expect(await reader.listModels("openai")).toEqual(models)
  })

  it("bounds every live fetch with a 15s timeout signal", async () => {
    const fetchFn = vi.fn(
      async (_url: unknown, _init?: unknown) => jsonResponse(modelsDevFixture),
    )
    const directory = createModelDirectory({
      fetchFn: fetchFn as unknown as typeof fetch,
      disableDiskCache: true,
    })

    await directory.listModels("openai")
    const init = fetchFn.mock.calls[0]?.[1] as { signal?: AbortSignal }
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("falls back to the anthropic snapshot when no API key is configured", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("should not fetch")
    }) as unknown as typeof fetch
    const directory = createModelDirectory({
      fetchFn,
      disableDiskCache: true,
      anthropicApiKey: () => undefined,
    })

    const models = await directory.listModels("anthropic")
    expect(fetchFn).not.toHaveBeenCalled()
    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ])
    expect(models.find((model) => model.id === "claude-haiku-4-5")).toEqual({
      id: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      description: "Fast, cost-efficient Claude for lighter tasks.",
    })
  })
})
