import { afterEach, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type { ModelRequest } from "../../src/runtime/model.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

afterEach(() => vi.restoreAllMocks())

const stepConfiguration = {
  name: "Personal",
  service: "stepfun",
  baseURL: "https://api.stepfun.ai/v1",
  wireApi: "openai_chat_completions" as const,
  models: [],
}
const metaConfiguration = {
  ...stepConfiguration,
  service: "meta",
  baseURL: "https://api.meta.ai/v1",
}
function catalog(data: unknown[]) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ data })))
}

it("uses Step Code's typed account catalog and explicit capability fields", async () => {
  catalog([
    {
      id: "step-3.7-flash",
      model_type: "大语言模型",
      max_input_tokens: 262144,
      enable_vision_input: true,
      reasoning_effort_support_list: ["low", "high"],
    },
    { id: "step-router-v1", model_type: "路由模型" },
    { id: "stepaudio-3-tts", model_type: "语音合成" },
    { id: "search-image" },
    {
      id: "step-3.5-flash",
      model_type: "大语言模型",
      enable_vision_input: false,
      enable_reason: false,
    },
    {
      id: "step-vision-unknown",
      model_type: "大语言模型",
      enable_vision_input: true,
    },
    {
      id: "step-generic-vision",
      model_type: "大语言模型",
      input_modalities: ["text", "image"],
    },
  ])
  const models = await discoverProviderModels(stepConfiguration, "unused")
  expect(models.map((model) => model.id)).toEqual([
    "step-3.7-flash",
    "step-3.5-flash",
    "step-router-v1",
    "step-vision-unknown",
    "step-generic-vision",
  ])
  const provider = createConfiguredProvider(
    "personal",
    { ...stepConfiguration, models },
    "unused",
  )
  const selection = { provider: "personal", model: "step-3.7-flash" }
  expect(provider.models.capacity(selection)).toMatchObject({
    contextWindowTokens: 262144,
    contextWindowScope: "input",
  })
  expect(provider.models.resolve(selection)).toMatchObject({
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    efforts: ["low", "high"],
  })
  expect(provider.models.resolve(selection).defaultEffort).toBeUndefined()
  expect(() =>
    provider.models.validate({ ...selection, effort: "medium" }),
  ).toThrow()
  expect(
    provider.models.resolve({ ...selection, model: "step-3.5-flash" }),
  ).toMatchObject({
    inputModalities: ["text"],
    imageDetailModes: [],
    efforts: [],
  })
  expect(
    provider.models.resolve({ ...selection, model: "step-vision-unknown" })
      .inputModalities,
  ).toEqual(["text"])
  expect(
    provider.models.resolve({ ...selection, model: "step-generic-vision" })
      .inputModalities,
  ).toEqual(["text"])
})

it("does not treat a missing Step model-list endpoint as account availability", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 404 }),
  )
  await expect(
    discoverProviderModels(stepConfiguration, "unused"),
  ).rejects.toThrow("HTTP 404")
})

it("fills Step's documented variants without inventing vision or base-model effort controls", async () => {
  const provider = createConfiguredProvider(
    "personal",
    {
      ...stepConfiguration,
      models: [
        { id: "step-3.7-flash" },
        { id: "step-3.5-flash-2603" },
        { id: "step-3.5-flash" },
      ],
    },
    "unused",
  )
  const selection = { provider: "personal", model: "step-3.5-flash-2603" }
  expect(provider.models.resolve(selection)).toMatchObject({
    inputModalities: ["text"],
    imageDetailModes: [],
    efforts: ["low", "high"],
  })
  expect(() =>
    provider.models.validate({ ...selection, effort: "medium" }),
  ).toThrow()
  expect(
    provider.models.resolve({ ...selection, model: "step-3.5-flash" }).efforts,
  ).toEqual([])
  expect(
    provider.models.resolve({ ...selection, model: "step-3.7-flash" }),
  ).toMatchObject({
    inputModalities: ["text", "image"],
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  })
})

it("resolves Muse Code Standard models and refuses unsupported reasoning selections", async () => {
  const provider = createConfiguredProvider(
    "personal",
    {
      ...metaConfiguration,
      models: [
        { id: "muse-spark-1.2" },
        { id: "muse-spark-1.3" },
        { id: "muse-wonder-1.0" },
      ],
    },
    "unused",
  )
  for (const model of ["muse-spark-1.2", "muse-spark-1.3", "muse-wonder-1.0"]) {
    const selection = { provider: "personal", model }
    expect(provider.models.resolve(selection).inputModalities).toEqual([
      "text",
      "image",
    ])
    expect(() =>
      provider.models.validate({ ...selection, effort: "none" }),
    ).toThrow()
    expect(() =>
      provider.models.validate({ ...selection, effort: "xhigh" }),
    ).not.toThrow()
  }
  expect(() =>
    provider.models.validate({
      provider: "personal",
      model: "muse-spark-1.2",
      effort: "max",
    }),
  ).toThrow()
  expect(() =>
    provider.models.validate({
      provider: "personal",
      model: "muse-spark-1.3",
      effort: "max",
    }),
  ).not.toThrow()
})

it.each([
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
])("does not discover, route or send %s without a data-training consent flow", async (model) => {
  const fetch = catalog([{ id: model }, { id: "muse-spark-1.2" }])
  expect(
    (await discoverProviderModels(metaConfiguration, "unused")).map(
      (entry) => entry.id,
    ),
  ).toEqual(["muse-spark-1.2"])
  const provider = createConfiguredProvider(
    "personal",
    {
      ...metaConfiguration,
      // Even a saved enable switch is not informed data-sharing consent.
      models: [{ id: model, visible: true }],
    },
    "unused",
  )
  expect(await provider.models.listModels({ includeHidden: true })).toEqual([])
  expect(() =>
    provider.models.resolve({ provider: "personal", model }),
  ).toThrow("not configured")
  fetch.mockClear()
  const request: ModelRequest = {
    target: { provider: "personal", model, instructionProfileId: "default" },
    system: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "Private code" }] },
    ],
    tools: [],
    toolWireProtocol: "eager",
  }
  const events = await Array.fromAsync(
    createChatCompletionsProvider({
      apiKey: "unused",
      model,
      baseURL: metaConfiguration.baseURL,
      flavor: "meta",
    })(request),
  )
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: {
      kind: "invalid_request",
      stage: "request_build",
      message: expect.stringContaining(
        "train on prompts, code, files and responses",
      ),
    },
  })
  expect(fetch).not.toHaveBeenCalled()
})
