import { describe, expect, it, vi } from "vitest"
import { directoryAllowlist } from "../../src/runtime/model-catalog.ts"
import { createModelDirectory } from "../../src/server/model-directory.ts"

const directoryFixture = {
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
      "gpt-4o-alpha": {
        id: "gpt-4o-alpha",
        name: "GPT-4o alpha",
        tool_call: true,
        status: "alpha",
        modalities: { input: ["text"], output: ["text"] },
      },
      "gpt-4o-audio": {
        id: "gpt-4o-audio",
        name: "GPT-4o Audio",
        tool_call: true,
        modalities: { input: ["audio"], output: ["audio"] },
      },
      "gpt-broken": "not-a-record",
    },
  },
  anthropic: {
    id: "anthropic",
    models: {
      // Fixture order deliberately differs from the allowlist order.
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
      },
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
  xai: {
    id: "xai",
    models: {
      // Fixture order deliberately differs from the allowlist order.
      "grok-4.3": {
        id: "grok-4.3",
        name: "Grok 4.3",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
      },
      "grok-4.5": {
        id: "grok-4.5",
        name: "Grok 4.5",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
      },
      "grok-code-fast-1": {
        id: "grok-code-fast-1",
        name: "Grok Code Fast 1",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
}

function fetchFixture(payload: unknown = directoryFixture) {
  return vi.fn(
    async () => new Response(JSON.stringify(payload)),
  ) as typeof fetch
}

describe("model directory", () => {
  it("filters and orders models.dev entries through the curated allowlist", async () => {
    const directory = createModelDirectory({ fetchFn: fetchFixture() })

    // Allowlist order wins over directory order; allowlisted ids absent from
    // the directory (gpt-5.6-sol) drop out silently. OpenAI reasoning models
    // also accept service tiers.
    expect(await directory.listModels("openai")).toEqual([
      {
        id: "gpt-5.1-codex",
        displayName: "GPT 5.1 Codex",
        family: "gpt",
        efforts: ["low", "medium", "high"],
        speeds: ["standard", "fast"],
      },
      {
        id: "gpt-5",
        displayName: "GPT-5",
        family: "gpt",
        efforts: ["low", "medium", "high"],
        speeds: ["standard", "fast"],
      },
    ])
  })

  it("maps the grok provider to the xai key and marks anthropic reasoning efforts", async () => {
    const directory = createModelDirectory({ fetchFn: fetchFixture() })

    // grok-code-fast-1 is sanitized but not in the grok allowlist; allowlist
    // order wins over fixture order.
    expect(await directory.listModels("grok")).toEqual([
      {
        id: "grok-4.5",
        displayName: "Grok 4.5",
        family: "default",
        efforts: ["low", "medium", "high"],
      },
      {
        id: "grok-4.3",
        displayName: "Grok 4.3",
        family: "default",
        efforts: ["low", "medium", "high"],
      },
    ])
    // Anthropic reasoning models offer efforts since the effort beta landed.
    expect(await directory.listModels("anthropic")).toEqual([
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        family: "anthropic",
        efforts: ["low", "medium", "high"],
      },
      {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        family: "anthropic",
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
    // Providers without an entry pass every sanitized model through.
    expect(directoryAllowlist("faux")).toBeUndefined()
    expect(directoryAllowlist("unknown")).toBeUndefined()
  })

  it("falls back to the curated catalog when the fetch fails", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const directory = createModelDirectory({ fetchFn })

    expect(await directory.listModels("openai")).toEqual([
      { id: "gpt-5.1-codex", displayName: "gpt-5.1-codex", family: "gpt" },
      { id: "gpt-5", displayName: "gpt-5", family: "gpt" },
    ])
  })

  it("falls back to the curated catalog for malformed payloads", async () => {
    for (const payload of [[], { openai: "junk" }, "nope"]) {
      const directory = createModelDirectory({ fetchFn: fetchFixture(payload) })
      expect(await directory.listModels("openai")).toEqual([
        { id: "gpt-5.1-codex", displayName: "gpt-5.1-codex", family: "gpt" },
        { id: "gpt-5", displayName: "gpt-5", family: "gpt" },
      ])
    }
  })

  it("serves faux from the curated catalog without fetching", async () => {
    const fetchFn = fetchFixture()
    const directory = createModelDirectory({ fetchFn })

    expect(await directory.listModels("faux")).toEqual([
      { id: "scripted", displayName: "scripted", family: "default" },
    ])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("serves kimi and codex from curated entries, never from models.dev", async () => {
    const fetchFn = fetchFixture()
    const directory = createModelDirectory({ fetchFn })

    expect(await directory.listModels("kimi")).toEqual([
      {
        id: "kimi-for-coding",
        displayName: "K2.7 Coding",
        family: "kimi",
      },
      {
        id: "kimi-for-coding-highspeed",
        displayName: "K2.7 Coding Highspeed",
        family: "kimi",
      },
      {
        id: "k3",
        displayName: "K3",
        family: "kimi",
        efforts: ["low", "high", "max"],
      },
      {
        id: "k3-256k",
        displayName: "K3-256k",
        family: "kimi",
        efforts: ["low", "high", "max"],
      },
    ])
    expect(await directory.listModels("codex")).toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        family: "gpt",
        efforts: ["low", "medium", "high", "xhigh"],
        speeds: ["standard", "fast"],
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        family: "gpt",
        efforts: ["low", "medium", "high", "xhigh"],
        speeds: ["standard", "fast"],
      },
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        family: "gpt",
        efforts: ["low", "medium", "high", "xhigh"],
        speeds: ["standard", "fast"],
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        family: "gpt",
        efforts: ["low", "medium", "high", "xhigh"],
        speeds: ["standard", "fast"],
      },
    ])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("caches the payload for the TTL and refetches after it", async () => {
    let now = 1_000
    const fetchFn = fetchFixture()
    const directory = createModelDirectory({
      fetchFn,
      now: () => now,
      ttlMs: 100,
    })

    await directory.listModels("openai")
    now = 1_050
    await directory.listModels("grok")
    expect(fetchFn).toHaveBeenCalledTimes(1)

    now = 1_200
    await directory.listModels("openai")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("serves the stale cache when a refresh after expiry fails", async () => {
    let now = 1_000
    let fail = false
    const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => {
      if (fail) throw new Error("network down")
      return fetchFixture()(_url as string | URL)
    })
    const directory = createModelDirectory({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
      ttlMs: 100,
    })

    const fresh = await directory.listModels("openai")
    now = 1_200
    fail = true
    const stale = await directory.listModels("openai")
    expect(stale).toEqual(fresh)
  })

  it("bounds the models.dev fetch with a timeout signal", async () => {
    const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => {
      void _url
      return new Response("{}", { status: 200 })
    })
    const directory = createModelDirectory({
      fetchFn: fetchFn as unknown as typeof fetch,
    })

    await directory.listModels("openai")
    const init = fetchFn.mock.calls[0]?.[1] as { signal?: AbortSignal }
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
