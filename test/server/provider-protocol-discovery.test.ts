import { createServer } from "node:http"
import { afterEach, expect, it, onTestFinished, vi } from "vitest"
import type { ProviderConfiguration } from "../../src/protocol/providers.ts"
import { providerPresets } from "../../src/runtime/provider-presets.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { requireConfiguredModels } from "../../src/server/provider-configuration.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

afterEach(() => vi.unstubAllGlobals())

it.each([
  {
    service: "moonshot",
    wireApi: "openai_responses",
    baseURL: "https://API.MOONSHOT.AI:443/v1/",
    path: "/v1/models",
    models: [
      "kimi-k2.6",
      "kimi-k3.1-pro-highspeed",
      "kimi-k3",
      "kimi-k3.1-pro",
      "kimi-k2.7-code",
      "k3.1-pro",
      "kimi-k3.1-pro-future",
      "KIMI-K3.1-PRO",
    ],
    expected: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"],
    authorization: "Bearer test-key",
  },
  {
    service: "nvidia",
    wireApi: "openai_chat_completions",
    baseURL: "https://integrate.api.nvidia.com/v1",
    path: "/v1/models",
    models: [
      "third-party/coder",
      "nvidia/nemotron-3.5-super-vl-120b-a12b-future",
      "nvidia/nemotron-3.5-super-vl-120b-a12b",
    ],
    expected: ["nvidia/nemotron-3.5-super-vl-120b-a12b"],
    authorization: "Bearer test-key",
  },
] as const)("discovers only adapted models on the official $service protocol", async (connection) => {
  const requests = await catalogEndpoint({
    data: connection.models.map((id) => ({ id })),
  })
  const configuration: ProviderConfiguration = {
    name: "Test account",
    service: connection.service,
    wireApi: connection.wireApi,
    baseURL: connection.baseURL,
    models: [],
  }

  const models = await discoverProviderModels(configuration, "test-key")

  expect(models.map((model) => model.id)).toEqual(connection.expected)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    path: connection.path,
    authorization: connection.authorization,
    apiKey: undefined,
  })
})

it.each([
  "kimi-k3.1-pro",
  "kimi-k3.1-pro-highspeed",
])("uses discovered %s account capabilities through a configured Responses request", async (model) => {
  const requests: { path: string; body: unknown }[] = []
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      requests.push({ path: url.pathname, body })
      if (url.pathname === "/v1/models")
        return Response.json({
          data: [
            {
              id: model,
              context_length: 262_144,
              input_modalities: ["text"],
              supported_reasoning_efforts: ["low"],
            },
          ],
        })
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_discovered",
            status: "completed",
            output: [],
            incomplete_details: null,
            error: null,
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  )
  const configuration: ProviderConfiguration = {
    name: "Renamed Kimi account",
    service: "moonshot",
    baseURL: "https://api.moonshot.ai/v1",
    wireApi: "openai_responses",
    models: [],
  }
  const models = await discoverProviderModels(configuration, "test-key")
  const provider = createConfiguredProvider(
    "personal",
    { ...configuration, models },
    "test-key",
  )
  const turn = provider.startTurn({ maxAttempts: 1 })
  onTestFinished(async () => {
    await turn.close()
    await provider.close?.()
  })
  const selection = { provider: "personal", model }
  expect((await turn.models.listModels()).map((entry) => entry.model)).toEqual([
    model,
  ])
  expect(turn.models.resolve(selection)).toMatchObject({
    inputModalities: ["text"],
    efforts: ["low"],
  })
  expect(turn.models.resolve(selection).defaultEffort).toBeUndefined()
  expect(turn.models.capacity(selection)?.contextWindowTokens).toBe(262_144)
  expect(() => turn.models.validate({ ...selection, effort: "max" })).toThrow()
  const events = []
  for await (const event of turn.stream({
    target: { ...selection, effort: "low", instructionProfileId: "default" },
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    toolWireProtocol: "eager",
  }))
    events.push(event)
  expect(events.at(-1)?.type).toBe("response")
  expect(requests).toEqual([
    { path: "/v1/models", body: undefined },
    {
      path: "/v1/responses",
      body: expect.objectContaining({ model, reasoning: { effort: "low" } }),
    },
  ])
})

it.each([
  {
    service: "glm",
    baseURL: "https://api.z.ai/api/paas/v4/",
    model: "glm-5.2",
  },
  {
    service: "minimax",
    baseURL: "https://api.minimax.io/v1",
    model: "MiniMax-M3.1-Flash",
  },
])("keeps reported $service capabilities ahead of exact preset defaults", async ({
  service,
  baseURL,
  model,
}) => {
  await catalogEndpoint({
    data: [
      {
        id: model,
        context_length: 32_000,
        max_output_tokens: 4_000,
        input_modalities: ["text"],
        supported_reasoning_efforts: ["low", "max"],
      },
      { id: `${model}-unknown` },
    ],
  })
  const configuration: ProviderConfiguration = {
    name: "Personal",
    service,
    wireApi: "openai_chat_completions",
    baseURL,
    models: [],
  }
  const models = await discoverProviderModels(configuration, "test-key")
  expect(models.map((entry) => entry.id)).toEqual([model, `${model}-unknown`])
  expect(models[0]).toMatchObject({
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    inputModalities: ["text"],
    efforts: ["low", "max"],
    defaultEffort: "max",
  })
  expect(models[1]?.inputModalities).toBeUndefined()
  const provider = createConfiguredProvider(
    "personal",
    { ...configuration, models },
    "test-key",
  )
  onTestFinished(() => provider.close?.())
  expect(
    provider.models.resolve({ provider: "personal", model }),
  ).toMatchObject({
    inputModalities: ["text"],
    maxOutputTokens: 4_000,
    efforts: ["low", "max"],
  })
  for (const unbound of [
    { ...configuration, baseURL: "https://relay.example/v1" },
    { ...configuration, baseURL: `${baseURL.replace(/\/$/, "")}/proxy` },
    { ...configuration, service: undefined },
  ]) {
    const { service: binding, ...rest } = unbound
    const discovered = await discoverProviderModels(
      { ...rest, ...(binding ? { service: binding } : {}) },
      "test-key",
    )
    expect(discovered[0]?.defaultEffort).toBeUndefined()
    expect(discovered[0]?.imageDetailModes).toBeUndefined()
  }
})

it.each(
  [
    {
      service: "glm",
      baseURL: "https://api.z.ai/api/paas/v4/",
      model: "glm-5.2",
    },
    {
      service: "minimax",
      baseURL: "https://api.minimax.io/v1",
      model: "MiniMax-M3.1-Flash",
    },
  ].flatMap((provider) => [
    {
      ...provider,
      state: "omitted",
      efforts: undefined,
      expectedDefault: "max",
    },
    {
      ...provider,
      state: "narrowed",
      efforts: ["low"],
      expectedDefault: undefined,
    },
    { ...provider, state: "disabled", efforts: [], expectedDefault: undefined },
  ]),
)("honors $service $state discovery efforts through configuration and the wire request", async ({
  service,
  baseURL,
  model,
  efforts,
  expectedDefault,
}) => {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: model,
              ...(efforts === undefined
                ? {}
                : { supported_reasoning_efforts: efforts }),
            },
          ],
        })
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(
        'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  )
  const configuration: ProviderConfiguration = {
    name: "Personal",
    service,
    wireApi: "openai_chat_completions",
    baseURL,
    models: [],
  }
  const discovered = await discoverProviderModels(configuration, "test-key")
  expect(discovered[0]?.defaultEffort).toBe(expectedDefault)
  if (efforts !== undefined) expect(discovered[0]?.efforts).toEqual(efforts)
  const models = requireConfiguredModels(discovered)
  const provider = createConfiguredProvider(
    "personal",
    { ...configuration, models },
    "test-key",
  )
  const turn = provider.startTurn({ maxAttempts: 1 })
  onTestFinished(async () => {
    await turn.close()
    await provider.close?.()
  })
  const selection = { provider: "personal", model }
  const step = SessionConfiguration.create(
    {
      selection,
      workspaceRoot: "/workspace",
      enabledTools: [],
      approvalPolicy: "always_approve",
      promptCacheKey: "discovered-efforts",
    },
    turn.models,
  ).resolveStep(selection, turn.models)
  expect(step.target.effort).toBe(expectedDefault)
  const events = []
  for await (const event of turn.stream({
    target: step.target,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    toolWireProtocol: "eager",
  }))
    events.push(event)
  expect(events.at(-1)?.type).toBe("response")
  expect(bodies).toHaveLength(1)
  expect(bodies[0]?.model).toBe(model)
  expect(bodies[0]?.reasoning_effort).toBe(expectedDefault)
})

it.each([
  { service: "moonshot", baseURL: "https://relay.example/v1" },
  { service: undefined, baseURL: "https://api.moonshot.ai/v1" },
])("does not apply service model restrictions to an unbound endpoint $baseURL", async (connection) => {
  await catalogEndpoint({ data: [{ id: "kimi-k2.6" }, { id: "custom-model" }] })
  const models = await discoverProviderModels(
    {
      name: "moonshot",
      preset: "moonshot",
      ...(connection.service === undefined
        ? {}
        : { service: connection.service }),
      baseURL: connection.baseURL,
      wireApi: "openai_responses",
      models: [],
    },
    "test-key",
  )
  expect(models.map((model) => model.id)).toEqual(["kimi-k2.6", "custom-model"])
})

it("does not substitute preset models when the requested protocol differs", async () => {
  await catalogEndpoint({}, 404)
  await expect(
    discoverProviderModels(
      {
        name: "Kimi Messages",
        service: "moonshot",
        baseURL: "https://api.moonshot.ai/v1",
        wireApi: "anthropic_messages",
        models: [],
      },
      "test-key",
    ),
  ).rejects.toThrow("Model catalog returned HTTP 404")
})

it("keeps a new Kimi Responses connection usable when the catalog endpoint is absent", async () => {
  const preset = providerPresets.find((entry) => entry.id === "moonshot")
  if (preset === undefined) throw new Error("Missing Kimi preset")
  const requests = await catalogEndpoint({}, 404)
  const models = await discoverProviderModels(
    {
      name: "Personal Kimi",
      service: preset.id,
      baseURL: preset.baseURL,
      wireApi: preset.wireApi,
      models: [],
    },
    "test-key",
  )

  expect(preset.wireApi).toBe("openai_responses")
  expect(models).toMatchObject([
    {
      id: "kimi-k3.1-pro",
      efforts: ["low", "high", "max"],
      defaultEffort: "max",
    },
    {
      id: "kimi-k3.1-pro-highspeed",
      efforts: ["low", "high", "max"],
      defaultEffort: "max",
    },
    { id: "kimi-k3", efforts: ["low", "high", "max"], defaultEffort: "max" },
  ])
  expect(requests).toEqual([
    { path: "/v1/models", authorization: "Bearer test-key", apiKey: undefined },
  ])
})

it("keeps old models available on an explicitly configured Chat connection", async () => {
  await catalogEndpoint({ data: [{ id: "kimi-k2.6" }, { id: "kimi-k3" }] })
  const models = await discoverProviderModels(
    {
      name: "Kimi Chat",
      service: "moonshot",
      baseURL: "https://api.moonshot.ai/v1",
      wireApi: "openai_chat_completions",
      models: [],
    },
    "test-key",
  )
  expect(models.map((model) => model.id)).toEqual(["kimi-k2.6", "kimi-k3"])
})

it.each([
  {
    baseURL: "https://api.siliconflow.cn/v1",
    path: "/v1/models?sub_type=chat",
  },
  { baseURL: "https://relay.example/v1", path: "/v1/models" },
])("uses SiliconFlow query parameters only on its confirmed endpoint $baseURL", async ({
  baseURL,
  path,
}) => {
  const requests = await catalogEndpoint({ data: [{ id: "coder" }] })
  await discoverProviderModels(
    {
      name: "Personal",
      service: "siliconflow",
      wireApi: "openai_chat_completions",
      baseURL,
      models: [],
    },
    "test-key",
  )
  expect(requests[0]?.path).toBe(path)
})

it.each([
  {
    baseURL: "https://openrouter.ai/api/v1",
    price: { inputPerMillion: 2, outputPerMillion: 8 },
  },
  { baseURL: "https://relay.example/v1", price: undefined },
])("interprets OpenRouter prices only on its confirmed endpoint $baseURL", async ({
  baseURL,
  price,
}) => {
  await catalogEndpoint({
    data: [
      { id: "coder", pricing: { prompt: "0.000002", completion: "0.000008" } },
    ],
  })
  const models = await discoverProviderModels(
    {
      name: "Personal",
      service: "openrouter",
      wireApi: "openai_chat_completions",
      baseURL,
      models: [],
    },
    "test-key",
  )
  expect(models[0]?.pricing).toEqual(price)
})

async function catalogEndpoint(body: object, status = 200) {
  const requests: {
    path: string | undefined
    authorization: string | undefined
    apiKey: string | string[] | undefined
  }[] = []
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"],
    })
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing port")
  const fetch = globalThis.fetch
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      return fetch(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        init,
      )
    },
  )
  return requests
}
