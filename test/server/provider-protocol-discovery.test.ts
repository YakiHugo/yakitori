import { createServer } from "node:http"
import { afterEach, expect, it, onTestFinished, vi } from "vitest"
import type { ProviderConfiguration } from "../../src/protocol/providers.ts"
import { providerPresets } from "../../src/runtime/provider-presets.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"

afterEach(() => vi.unstubAllGlobals())

it.each([
  {
    service: "moonshot",
    wireApi: "openai_responses",
    baseURL: "https://API.MOONSHOT.AI:443/v1/",
    path: "/v1/models",
    models: ["kimi-k2.6", "kimi-k3", "kimi-k2.7-code"],
    expected: ["kimi-k3"],
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

  expect(models.map((model) => model.id).sort()).toEqual(connection.expected)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    path: connection.path,
    authorization: connection.authorization,
    apiKey: undefined,
  })
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
