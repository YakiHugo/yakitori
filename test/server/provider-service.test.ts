import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { providerPresets } from "../../src/runtime/provider-presets.ts"
import {
  createProviderRegistry,
  type ModelRequest,
} from "../../src/runtime/index.ts"
import { ConfigurationError } from "../../src/server/config-errors.ts"
import {
  providerConfigValue,
  requireProviderConfiguration,
} from "../../src/server/provider-configuration.ts"
import { createProviderService } from "../../src/server/provider-service.ts"
import { createModelSourceTool } from "../../src/server/model-source-tools.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-providers-"))
  directories.push(directory)
  const configPath = join(directory, "config.toml")
  const credentialDirectory = join(directory, "keys")
  const userConfig = createUserConfigStore({ configPath })
  const registry = createProviderRegistry({})
  const service = createProviderService({
    userConfig,
    credentialDirectory,
    apply: (providers) => registry.replace(providers),
  })
  return { service, registry, userConfig, configPath, credentialDirectory }
}

const configuration = {
  name: "Personal",
  wireApi: "openai_chat_completions",
  baseURL: "http://127.0.0.1:1/v1",
  models: [{ id: "coding-model", contextWindowTokens: 64000 }],
} as const

describe("provider configuration", () => {
  it("uses documented preset models only when the official catalog endpoint is unsupported", async () => {
    const preset = providerPresets.find((entry) => entry.id === "minimax")
    if (!preset) throw new Error("Missing preset")
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    vi.stubGlobal("fetch", fetch)
    const connection = {
      name: preset.name,
      preset: preset.id,
      wireApi: preset.wireApi,
      baseURL: preset.baseURL,
      models: [],
    }
    expect(await discoverProviderModels(connection, "key")).toEqual(
      preset.models,
    )
    await expect(
      discoverProviderModels(
        { ...connection, baseURL: "https://custom.example/v1" },
        "key",
      ),
    ).rejects.toThrow("HTTP 404")
    fetch.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(discoverProviderModels(connection, "key")).rejects.toThrow(
      "HTTP 401",
    )
  })

  it("lets the model save a local source without inventing IDs and restores its discovered models", async () => {
    const seen: {
      path: string | undefined
      authorization: string | undefined
    }[] = []
    const endpoint = createServer((request, response) => {
      seen.push({
        path: request.url,
        authorization: request.headers.authorization,
      })
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          data: [
            {
              id: "upstream-coder",
              name: "Upstream Coder",
              context_length: 32768,
            },
          ],
        }),
      )
    })
    await new Promise<void>((resolve) =>
      endpoint.listen(0, "127.0.0.1", resolve),
    )
    try {
      const address = endpoint.address()
      if (!address || typeof address === "string")
        throw new Error("Missing address")
      const { service, registry, userConfig, configPath, credentialDirectory } =
        await fixture()
      const tool = createModelSourceTool(service)
      const saved = await tool.execute(
        {
          action: "save",
          name: "Local coder",
          base_url: `http://127.0.0.1:${address.port}/v1`,
          no_key: true,
        },
        { workspaceRoot: tmpdir() },
      )
      expect(saved.ok).toBe(true)
      expect(seen).toEqual([{ path: "/v1/models", authorization: undefined }])
      const source = (await service.read()).providers[0]
      expect(source).toMatchObject({
        id: "local-coder",
        credential: "optional",
        configuration: { models: [] },
        catalog: {
          models: [
            {
              id: "upstream-coder",
              displayName: "Upstream Coder",
              contextWindowTokens: 32768,
            },
          ],
        },
      })
      expect(
        (await registry.models("local-coder").listModels()).map(
          (model) => model.model,
        ),
      ).toEqual(["upstream-coder"])
      expect(
        (await userConfig.readConfiguration()).modelProviders?.["local-coder"]
          ?.credentialRef,
      ).toBeUndefined()
      const restartedRegistry = createProviderRegistry({})
      const restarted = createProviderService({
        userConfig: createUserConfigStore({ configPath }),
        credentialDirectory,
        apply: (providers) => restartedRegistry.replace(providers),
      })
      await restarted.reload()
      expect(await restarted.read()).toEqual(await service.read())
      expect(
        (await restartedRegistry.models("local-coder").listModels()).map(
          (model) => model.model,
        ),
      ).toEqual(["upstream-coder"])
      await tool.execute(
        {
          action: "save",
          name: "Local coder",
          base_url: `http://127.0.0.1:${address.port}/v1`,
          no_key: true,
        },
        { workspaceRoot: tmpdir() },
      )
      expect(registry.providers).toEqual(["local-coder", "local-coder-2"])
      await tool.execute(
        { action: "save", id: "local-coder", enabled: false },
        { workspaceRoot: tmpdir() },
      )
      expect(registry.providers).toEqual(["local-coder-2"])
      await tool.execute(
        { action: "remove", id: "local-coder-2" },
        { workspaceRoot: tmpdir() },
      )
      expect(registry.providers).toEqual([])
    } finally {
      endpoint.closeAllConnections()
      await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    }
  })

  it("rejects a failed catalog without persisting the supplied credential or configuration", async () => {
    const endpoint = createServer((_request, response) => {
      response.writeHead(401)
      response.end()
    })
    await new Promise<void>((resolve) =>
      endpoint.listen(0, "127.0.0.1", resolve),
    )
    try {
      const address = endpoint.address()
      if (!address || typeof address === "string")
        throw new Error("Missing address")
      const { service, userConfig, credentialDirectory, registry } =
        await fixture()
      await expect(
        service.write({
          configuration: {
            ...configuration,
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            models: [],
          },
          apiKey: "invalid-key",
        }),
      ).rejects.toThrow("HTTP 401")
      expect(
        (await userConfig.readConfiguration()).modelProviders,
      ).toBeUndefined()
      await expect(readdir(credentialDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      })
      expect(registry.providers).toEqual([])
    } finally {
      endpoint.closeAllConnections()
      await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    }
  })

  it("discovers all authenticated Messages catalog pages and excludes reported non-chat models", async () => {
    const seen: {
      path: string | undefined
      key: string | string[] | undefined
      version: string | string[] | undefined
    }[] = []
    const endpoint = createServer((request, response) => {
      seen.push({
        path: request.url,
        key: request.headers["x-api-key"],
        version: request.headers["anthropic-version"],
      })
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify(
          request.url?.includes("after_id")
            ? {
                data: [{ id: "coder-b", display_name: "Coder B" }],
                has_more: false,
              }
            : {
                data: [
                  { id: "coder-a" },
                  { id: "embedding", capabilities: { completion_chat: false } },
                ],
                has_more: true,
                last_id: "coder-a",
              },
        ),
      )
    })
    await new Promise<void>((resolve) =>
      endpoint.listen(0, "127.0.0.1", resolve),
    )
    try {
      const address = endpoint.address()
      if (!address || typeof address === "string")
        throw new Error("Missing address")
      expect(
        await discoverProviderModels(
          {
            ...configuration,
            wireApi: "anthropic_messages",
            baseURL: `http://127.0.0.1:${address.port}`,
            models: [],
          },
          "catalog-key",
        ),
      ).toEqual([{ id: "coder-a" }, { id: "coder-b", displayName: "Coder B" }])
      expect(seen).toEqual([
        { path: "/v1/models", key: "catalog-key", version: "2023-06-01" },
        {
          path: "/v1/models?after_id=coder-a",
          key: "catalog-key",
          version: "2023-06-01",
        },
      ])
    } finally {
      endpoint.closeAllConnections()
      await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    }
  })
  it("retains protected credential references for undo after the last connection is removed", async () => {
    const { service, userConfig, configPath, credentialDirectory } =
      await fixture()
    await service.write({ id: "personal", configuration, apiKey: "shared" })
    const provider = (await userConfig.readConfiguration()).modelProviders
      ?.personal
    if (provider === undefined) throw new Error("Missing saved provider")
    await userConfig.writeValue({
      keyPath: ["model_providers", "work"],
      value: providerConfigValue({ ...provider, name: "Work" }),
    })
    await service.reload()
    await service.write({
      id: "personal",
      configuration,
      apiKey: "replacement",
    })
    await service.delete("personal")
    const restarted = createProviderService({
      userConfig: createUserConfigStore({ configPath }),
      credentialDirectory,
      apply() {},
    })
    await restarted.reload()
    expect((await restarted.read()).providers).toMatchObject([
      {
        id: "work",
        configuration: { ...configuration, name: "Work" },
        credential: "stored",
      },
    ])
    expect(await readdir(credentialDirectory)).toHaveLength(2)
    const deleted = await restarted.delete("work")
    if (!deleted.undoId) throw new Error("Missing undo token")
    await restarted.restore(deleted.undoId)
    expect((await restarted.read()).providers[0]?.credential).toBe("stored")
  })

  it("persists connections with separately protected credentials and restores them after restart", async () => {
    const fixtureData = await fixture()
    const { service, userConfig, registry, configPath, credentialDirectory } =
      fixtureData
    const response = await service.write({
      id: "personal",
      configuration,
      apiKey: "secret-one",
    })
    expect(response.providers[0]).toMatchObject({
      id: "personal",
      configuration,
      credential: "stored",
    })
    expect(JSON.stringify(await userConfig.readSnapshot())).not.toContain(
      "secret-one",
    )
    expect(await readFile(configPath, "utf8")).not.toContain("secret-one")
    expect(registry.providers).toEqual(["personal"])
    const references = await readdir(credentialDirectory)
    expect(references).toHaveLength(1)
    expect(
      await readFile(join(credentialDirectory, references.at(0) ?? ""), "utf8"),
    ).toBe("secret-one")
    if (process.platform !== "win32")
      expect(
        (await stat(join(credentialDirectory, references.at(0) ?? ""))).mode &
          0o777,
      ).toBe(0o600)
    const restored = createProviderRegistry({})
    const next = createProviderService({
      userConfig: createUserConfigStore({ configPath }),
      credentialDirectory,
      apply: (providers) => restored.replace(providers),
    })
    await next.reload()
    expect(
      restored
        .models("personal")
        .resolve({ provider: "personal", model: "coding-model" })
        .fileEditingToolType,
    ).toBe("edit_write")
    expect((await next.read()).providers).toEqual(response.providers)
    await next.write({
      id: "personal",
      configuration: { ...configuration, name: "Renamed" },
    })
    expect(
      await readFile(join(credentialDirectory, references.at(0) ?? ""), "utf8"),
    ).toBe("secret-one")
    await next.write({ id: "personal", configuration, apiKey: "secret-two" })
    const rotated = await readdir(credentialDirectory)
    expect(rotated).toHaveLength(2)
    expect(rotated).not.toEqual(references)
    await next.delete("personal")
    expect(restored.providers).toEqual([])
    expect(await readdir(credentialDirectory)).toHaveLength(2)
    expect(
      (await userConfig.readConfiguration()).modelProviders,
    ).toBeUndefined()
  })

  it("lists missing credentials without admitting the connection", async () => {
    const { service, registry } = await fixture()
    const result = await service.write({ id: "personal", configuration })
    expect(result.providers[0]?.credential).toBe("missing")
    expect(registry.providers).toEqual([])
  })

  it("validates connection changes before modifying durable state", async () => {
    const { service, configPath, credentialDirectory } = await fixture()
    await service.write({ id: "personal", configuration, apiKey: "secret" })
    const previous = await readFile(configPath, "utf8")
    const keys = await readdir(credentialDirectory)
    for (const invalid of [
      { ...configuration, baseURL: "file:///tmp/model" },
      { ...configuration, models: [] },
      { ...configuration, baseURL: "https://user:secret@example.com" },
      { ...configuration, models: [{ id: "model", defaultEffort: "high" }] },
    ]) {
      await expect(
        service.write({
          id: "personal",
          configuration: invalid,
          apiKey: "replace",
        }),
      ).rejects.toThrow()
      expect(await readFile(configPath, "utf8")).toBe(previous)
      expect(await readdir(credentialDirectory)).toEqual(keys)
    }
    expect(() =>
      requireProviderConfiguration({
        ...configuration,
        models: [{ id: "model", efforts: [] }],
      }),
    ).not.toThrow()
    expect(() =>
      requireProviderConfiguration({
        ...configuration,
        models: [{ id: "model", instructionProfileId: "unknown" }],
      }),
    ).toThrow(ConfigurationError)
  })

  it("uses the configured endpoint and key for a real stream and an unsaved connection test", async () => {
    const seen: {
      authorization: string | undefined
      path: string | undefined
      body: string
    }[] = []
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      seen.push({
        authorization: request.headers.authorization,
        path: request.url,
        body,
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        'data: {"id":"completion","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"completion","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (typeof address !== "object" || address === null)
        throw new Error("Missing server address")
      const connection = {
        ...configuration,
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      }
      const { service, registry, userConfig } = await fixture()
      await expect(
        service.test({
          id: "test",
          configuration: connection,
          apiKey: "unsaved",
        }),
      ).resolves.toEqual({ ok: true })
      expect(
        (await userConfig.readConfiguration()).modelProviders,
      ).toBeUndefined()
      await service.write({
        id: "personal",
        configuration: connection,
        apiKey: "saved",
      })
      const modelRequest: ModelRequest = {
        target: {
          provider: "personal",
          model: "coding-model",
          instructionProfileId: "default",
        },
        system: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }] },
        ],
        tools: [],
        toolWireProtocol: "eager",
      }
      const events = []
      for await (const event of registry.stream(modelRequest))
        events.push(event)
      expect(events.at(-1)).toMatchObject({ type: "response" })
      expect(
        seen.map(({ authorization, path }) => ({ authorization, path })),
      ).toEqual([
        { authorization: "Bearer unsaved", path: "/v1/chat/completions" },
        { authorization: "Bearer saved", path: "/v1/models" },
        { authorization: "Bearer saved", path: "/v1/chat/completions" },
      ])
      expect(JSON.parse(seen.at(-1)?.body ?? "")).toMatchObject({
        model: "coding-model",
        stream: true,
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})

it("reads model capacities, modalities and token prices from the OpenRouter catalog", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "vendor/coder",
                context_length: 128000,
                top_provider: { max_completion_tokens: 16000 },
                architecture: {
                  input_modalities: ["text", "image"],
                  output_modalities: ["text"],
                },
                supported_reasoning_efforts: ["low", "high"],
                pricing: {
                  prompt: "0.00000125",
                  completion: "0.000005",
                  input_cache_read: "0.00000025",
                },
              },
              {
                id: "image-generator",
                architecture: { output_modalities: ["image"] },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  )
  expect(
    await discoverProviderModels(
      {
        ...configuration,
        preset: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        models: [],
      },
      "key",
    ),
  ).toEqual([
    {
      id: "vendor/coder",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
      inputModalities: ["text", "image"],
      efforts: ["low", "high"],
      pricing: {
        inputPerMillion: 1.25,
        outputPerMillion: 5,
        cacheReadPerMillion: 0.25,
      },
    },
  ])
})
