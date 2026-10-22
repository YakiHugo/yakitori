import type OpenAI from "openai"
import { expect, it } from "vitest"
import type { ProviderModelSettings } from "../../src/protocol/providers.ts"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createModelSettingsManager } from "../../src/runtime/model-settings-manager.ts"
import {
  createDiscoveringModelsManager,
  type DiscoveredModel,
} from "../../src/runtime/models-manager.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { withSDKResponse } from "../support/sdk-response.ts"

it("keeps provider data, app visibility, and user overrides independent through refresh", async () => {
  let upstream: readonly DiscoveredModel[] = [
    {
      id: "new-coder",
      defaultEffort: "high",
      efforts: ["low", "high"],
      contextWindowTokens: 100000,
    },
    { id: "hidden-coder", defaultVisible: false },
  ]
  const writes: (readonly DiscoveredModel[])[] = []
  const source = createDiscoveringModelsManager({
    provider: "codex",
    identity: async () => "account",
    discover: async () => upstream,
    cacheStore: {
      load: async () => undefined,
      save: async (entry) => {
        writes.push(entry.models)
      },
    },
  })
  const settings: ProviderModelSettings = {
    "new-coder": { contextWindowTokens: 64000, defaultEffort: "low" },
    "hidden-coder": { visible: true },
    "manual-coder": { inputModalities: ["text", "image"] },
  }
  const manager = createModelSettingsManager(source, () => settings)
  expect((await manager.listModels()).map((model) => model.model)).toEqual([
    "new-coder",
    "hidden-coder",
    "manual-coder",
  ])
  expect(
    manager.resolve({ provider: "codex", model: "new-coder" }).defaultEffort,
  ).toBe("low")
  expect(
    manager.capacity({ provider: "codex", model: "new-coder" })
      ?.contextWindowTokens,
  ).toBe(64000)
  expect(
    manager.resolve({ provider: "codex", model: "manual-coder" }),
  ).toMatchObject({
    instructionProfileId: "default",
    inputModalities: ["text", "image"],
    fileEditingToolType: "edit_write",
  })
  upstream = [...upstream, { id: "later-coder" }]
  await manager.refresh({ force: true })
  expect((await manager.listModels()).map((model) => model.model)).toEqual([
    "new-coder",
    "hidden-coder",
    "later-coder",
    "manual-coder",
  ])
  expect(writes[0]?.[0]?.contextWindowTokens).toBe(100000)
  expect(writes.flat().some((model) => model.id === "manual-coder")).toBe(false)
})

it.each([
  { efforts: [] },
  { efforts: ["low"] },
])("validates effective efforts $efforts without dropping the source speed contract", async ({
  efforts,
}) => {
  const source = createConfiguredModelsManager({
    provider: "work",
    models: [
      {
        id: "coder",
        efforts: ["low", "high"],
        defaultEffort: "high",
        speeds: ["standard"],
      },
    ],
  })
  const manager = createModelSettingsManager(source, () => ({
    coder: { efforts },
  }))
  expect(
    manager.resolve({ provider: "work", model: "coder" }).defaultEffort,
  ).toBeUndefined()
  const [listed] = await manager.listModels()
  expect(listed?.efforts).toEqual(efforts)
  expect(listed?.defaultEffort).toBeUndefined()
  expect(
    source.resolve({ provider: "work", model: "coder" }).defaultEffort,
  ).toBe("high")
  expect(() =>
    manager.validate({ provider: "work", model: "coder", effort: "high" }),
  ).toThrow("not supported")
  expect(() =>
    manager.validate({ provider: "work", model: "coder", speed: "fast" }),
  ).toThrow("not supported")
})

it.each([
  { defaultEffort: "invalid" },
  { efforts: ["low"], defaultEffort: "high" },
])("rejects explicit defaults outside the effective effort list %j", async (override) => {
  const manager = createModelSettingsManager(
    createConfiguredModelsManager({
      provider: "work",
      models: [
        { id: "coder", efforts: ["low", "high"], defaultEffort: "high" },
      ],
    }),
    () => ({ coder: override }),
  )
  expect(() => manager.resolve({ provider: "work", model: "coder" })).toThrow(
    "Default effort",
  )
  await expect(manager.listModels()).rejects.toThrow("Default effort")
})

it("keeps an explicit default when the source has no known effort list", async () => {
  const manager = createModelSettingsManager(
    createConfiguredModelsManager({
      provider: "work",
      models: [{ id: "coder" }],
    }),
    () => ({ coder: { defaultEffort: "custom" } }),
  )
  expect(
    manager.resolve({ provider: "work", model: "coder" }).defaultEffort,
  ).toBe("custom")
  expect((await manager.listModels())[0]?.defaultEffort).toBe("custom")
})

it("captures user model settings for active Turns while applying new settings to later Turns", async () => {
  let settings: ProviderModelSettings = {
    coder: { maxOutputTokens: 1000, defaultEffort: "low" },
  }
  const seen: (string | undefined)[] = []
  const registry = createProviderRegistry(
    {
      work: createModelProvider({
        info: {
          id: "work",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false },
        },
        models: createConfiguredModelsManager({
          provider: "work",
          models: [
            { id: "coder", efforts: ["low", "high"], defaultEffort: "high" },
          ],
        }),
        stream: async function* (request) {
          seen.push(request.reasoning?.defaultEffort)
          yield {
            type: "response",
            response: { stopReason: "end_turn", content: [] },
          }
        },
      }),
    },
    { settings: () => settings },
  )
  const client = registry.createClient()
  const active = client.startTurn("work")
  settings = { coder: { maxOutputTokens: 2000, defaultEffort: "high" } }
  const next = client.startTurn("work")
  expect(
    active.models.resolve({ provider: "work", model: "coder" }).maxOutputTokens,
  ).toBe(1000)
  expect(
    next.models.resolve({ provider: "work", model: "coder" }).maxOutputTokens,
  ).toBe(2000)
  for (const turn of [active, next])
    for await (const event of turn.stream({
      target: {
        provider: "work",
        model: "coder",
        instructionProfileId: "default",
      },
      system: [],
      messages: [],
      tools: [],
      toolWireProtocol: "eager",
      signal: new AbortController().signal,
    }))
      void event
  expect(seen).toEqual(["low", "high"])
  await client.close()
  await registry.close()
})

it("preserves app reasoning aliases through a user override and the actual request builder", async () => {
  let body: unknown
  const client = withSDKResponse({
    responses: {
      async create(input: unknown) {
        body = input
        return (async function* () {
          yield {
            type: "response.completed",
            response: {
              id: "response",
              model: "gpt-6-astra",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          }
        })()
      },
    },
  } as unknown as OpenAI)
  const registry = createProviderRegistry(
    {
      codex: createModelProvider({
        info: {
          id: "codex",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false },
        },
        stream: createOpenAIProvider({
          apiKey: "fixture",
          model: "gpt-6-astra",
          client,
        }),
      }),
    },
    { settings: () => ({ "gpt-6-astra": { contextWindowTokens: 64000 } }) },
  )
  try {
    for await (const event of registry.stream({
      target: {
        provider: "codex",
        model: "gpt-6-astra",
        instructionProfileId: "gpt-6-astra",
        effort: "ultra",
      },
      system: [],
      messages: [],
      tools: [],
      toolWireProtocol: "eager",
    }))
      void event
    expect(body).toMatchObject({
      model: "gpt-6-astra",
      reasoning: { effort: "xhigh" },
    })
  } finally {
    await registry.close()
  }
})

it("does not turn a generation model into a chat model through a visibility override", async () => {
  const source = createDiscoveringModelsManager({
    provider: "grok",
    identity: async () => "account",
    discover: async () => [
      { id: "new-coder" },
      { id: "draw", kind: "image" },
      { id: "film", kind: "video" },
    ],
  })
  const manager = createModelSettingsManager(source, () => ({
    draw: { visible: true },
    film: { visible: true },
  }))
  expect(
    (await manager.listModels({ includeHidden: true })).map((m) => m.model),
  ).toEqual(["new-coder"])
  expect(() => manager.resolve({ provider: "grok", model: "draw" })).toThrow(
    "not a chat model",
  )
  expect(() => manager.validate({ provider: "grok", model: "film" })).toThrow(
    "not a chat model",
  )
})
