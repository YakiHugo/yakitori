import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { providerPresets } from "../../src/runtime/provider-presets.ts"
import {
  providerConfigValue,
  providersFromConfig,
  requireProviderConfiguration,
} from "../../src/server/provider-configuration.ts"
import { createModelSourceTool } from "../../src/server/model-source-tools.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"
import { createProviderService } from "../../src/server/provider-service.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"

afterEach(() => vi.unstubAllGlobals())

const configuration = {
  name: "Gemini",
  preset: "gemini",
  wireApi: "gemini_generate_content",
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  models: [],
} as const

it("round-trips native Gemini settings without changing explicit compatibility connections", () => {
  const native = requireProviderConfiguration({
    ...configuration,
    models: [
      {
        id: "gemini-model",
        contextWindowTokens: 100,
        contextWindowScope: "input",
        maxOutputTokens: 200,
      },
    ],
  })
  const compatibility = requireProviderConfiguration({
    ...configuration,
    wireApi: "openai_chat_completions",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  })
  expect(providerConfigValue(native).api_backend).toBe("generate_content")
  expect(providerConfigValue(compatibility).api_backend).toBe(
    "chat_completions",
  )
  expect(
    providersFromConfig({
      native: providerConfigValue(native),
      compatibility: providerConfigValue(compatibility),
    }),
  ).toEqual({ native, compatibility })
  expect(
    providerPresets.find((preset) => preset.id === "gemini"),
  ).toMatchObject({
    wireApi: "gemini_generate_content",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
  })
  for (const models of [
    [{ id: "invalid", contextWindowScope: "combined" }],
    [{ id: "invalid", contextWindowTokens: 100, maxOutputTokens: 200 }],
  ]) {
    expect(() =>
      requireProviderConfiguration({ ...configuration, models }),
    ).toThrow()
  }
})

it("discovers native pages using header authentication and persists input-only limits across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-gemini-catalog-"))
  const requests: {
    path: string | undefined
    key: string | string[] | undefined
    authorization: string | undefined
  }[] = []
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      key: request.headers["x-goog-api-key"],
      authorization: request.headers.authorization,
    })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify(
        request.url?.includes("pageToken=")
          ? {
              models: [
                {
                  name: "models/native-b",
                  displayName: "Native B",
                  inputTokenLimit: 1024,
                  outputTokenLimit: 2048,
                  supportedGenerationMethods: ["generateContent"],
                },
              ],
            }
          : {
              models: [
                {
                  name: "models/native-a",
                  inputTokenLimit: 32768,
                  outputTokenLimit: 8192,
                  thinking: true,
                  supportedGenerationMethods: [
                    "generateContent",
                    "countTokens",
                  ],
                },
                {
                  name: "models/embedding",
                  supportedGenerationMethods: ["embedContent"],
                },
                { name: "models/unknown-methods" },
              ],
              nextPageToken: "next page+token",
            },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Missing catalog address")
    const create = () => {
      const registry = createProviderRegistry({})
      const service = createProviderService({
        userConfig: createUserConfigStore({
          configPath: join(directory, "config.toml"),
        }),
        credentialDirectory: join(directory, "keys"),
        apply: (providers) => registry.replace(providers),
      })
      return { registry, service }
    }
    const initial = create()
    const result = await createModelSourceTool(initial.service).execute(
      {
        action: "save",
        name: "Native Gemini",
        api_backend: "generate_content",
        base_url: `http://127.0.0.1:${address.port}/v1beta`,
        api_key: "catalog-secret",
      },
      { workspaceRoot: directory },
    )
    expect(result.ok).toBe(true)
    expect(requests).toEqual([
      {
        path: "/v1beta/models",
        key: "catalog-secret",
        authorization: undefined,
      },
      {
        path: "/v1beta/models?pageToken=next+page%2Btoken",
        key: "catalog-secret",
        authorization: undefined,
      },
    ])
    expect(JSON.stringify(result)).not.toContain("catalog-secret")
    const persisted = await readFile(join(directory, "config.toml"), "utf8")
    expect(persisted).toContain('api_backend = "generate_content"')
    expect(persisted).not.toContain("catalog-secret")
    const restarted = create()
    await restarted.service.reload()
    const manager = restarted.registry.models("native-gemini")
    expect(
      (await manager.listModels()).map((model) => ({
        id: model.model,
        efforts: model.efforts,
        inputModalities: model.inputModalities,
      })),
    ).toEqual([
      { id: "native-a", efforts: [], inputModalities: ["text"] },
      { id: "native-b", efforts: [], inputModalities: ["text"] },
    ])
    expect(
      manager.capacity({ provider: "native-gemini", model: "native-b" }),
    ).toEqual({
      contextWindowTokens: 1024,
      maxContextWindowTokens: 1024,
      contextWindowScope: "input",
      effectiveContextWindowPercent: 100,
    })
    expect(
      manager.resolve({ provider: "native-gemini", model: "native-b" })
        .maxOutputTokens,
    ).toBe(2048)
    expect(requests).toHaveLength(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

it("keeps only confirmed image metadata and does not invent native effort levels", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        models: [
          {
            name: "models/unknown-model",
            thinking: true,
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-3.8-flash",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    ),
  )
  expect(await discoverProviderModels(configuration, "key")).toEqual([
    { id: "gemini-3.8-flash", inputModalities: ["text", "image"] },
    { id: "unknown-model" },
  ])
})

it.each([
  [{ data: [] }, "models array"],
  [{ models: [{ name: "gemini-model" }] }, "model resource name"],
  [{ models: [], nextPageToken: 42 }, "invalid nextPageToken"],
  [{ models: [], nextPageToken: "repeat" }, "repeated a page"],
  [
    {
      models: [
        {
          name: "models/embedding",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    },
    "no chat models",
  ],
] as const)("rejects malformed or unusable native catalogs: %j", async (body, message) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body)),
  )
  await expect(discoverProviderModels(configuration, "key")).rejects.toThrow(
    message,
  )
})

it.each([
  401, 404, 429, 503,
])("keeps native catalog HTTP %i failures visible", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status })),
  )
  await expect(discoverProviderModels(configuration, "key")).rejects.toThrow(
    `HTTP ${status}`,
  )
})
