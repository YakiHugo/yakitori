import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, onTestFinished, vi } from "vitest"
import type { ModelCatalogResponse } from "../../../src/protocol/providers.ts"
import type { ProviderRpcParams } from "../../../src/protocol/rpc-provider.ts"
import { createProviderRegistry } from "../../../src/runtime/provider-registry.ts"
import { createProviderService } from "../../../src/server/provider-service.ts"
import { createUserConfigStore } from "../../../src/server/user-config.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  openTestConnection,
  type TestConnection,
} from "./testkit.ts"

afterEach(() => vi.unstubAllGlobals())

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-title-model-rpc-"))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  vi.stubGlobal("fetch", async () =>
    Response.json({
      data: [
        { id: "coder", kind: "chat" },
        { id: "Title-Model", kind: "chat" },
        { id: "image-model", kind: "image" },
      ],
    }),
  )
  const configPath = join(directory, "config.toml")
  const userConfig = createUserConfigStore({ configPath })
  const registry = createProviderRegistry({})
  onTestFinished(() => registry.close())
  const source = registry.register("accounts", {})
  const service = createProviderService({
    userConfig,
    credentialDirectory: join(directory, "keys"),
    registry: () => registry,
    apply(providers) {
      void source.replace(providers)
    },
  })
  await service.write({
    id: "personal",
    configuration: {
      name: "Personal",
      wireApi: "openai_chat_completions",
      baseURL: "http://127.0.0.1:1/v1",
      models: [{ id: "Title-Model", visible: false }],
    },
    apiKey: "account-key",
  })
  const { processor } = createTestProcessor({
    handlers: createFakeHandlers(),
    providerConfiguration: service,
    userConfig,
  })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  return { connection, userConfig, configPath }
}

async function requestCatalog(
  connection: TestConnection,
  method: "provider/models/read" | "provider/title-model/write",
  params:
    | ProviderRpcParams["provider/models/read"]
    | ProviderRpcParams["provider/title-model/write"],
): Promise<ModelCatalogResponse> {
  const response = await connection.sendRequest(method, params)
  if (!("result" in response)) throw new Error(JSON.stringify(response))
  return response.result as ModelCatalogResponse
}

it("writes and resets account title models through RPC with catalog versions", async () => {
  const { connection, userConfig } = await fixture()
  const before = await userConfig.readConfiguration()
  const initial = await requestCatalog(connection, "provider/models/read", {
    provider: "personal",
  })
  expect(initial).not.toHaveProperty("titleModel")
  const selected = await requestCatalog(
    connection,
    "provider/title-model/write",
    {
      provider: "personal",
      titleModel: "TITLE-MODEL",
      version: initial.version,
    },
  )
  expect(selected.titleModel).toBe("Title-Model")
  expect(selected.version).not.toBe(initial.version)
  expect(selected.models).toContainEqual(
    expect.objectContaining({ id: "Title-Model", visible: false }),
  )
  expect(
    (await userConfig.readConfiguration()).modelProviders?.personal?.titleModel,
  ).toBe("Title-Model")
  expect(
    await requestCatalog(connection, "provider/models/read", {
      provider: "personal",
    }),
  ).toEqual(selected)

  for (const titleModel of ["coder", null]) {
    expect(
      await connection.sendRequest("provider/title-model/write", {
        provider: "personal",
        titleModel,
        version: initial.version,
      }),
    ).toMatchObject({
      error: { code: -32009, data: { code: "conflict" } },
    })
  }
  expect(
    (await userConfig.readConfiguration()).modelProviders?.personal?.titleModel,
  ).toBe("Title-Model")

  const reset = await requestCatalog(connection, "provider/title-model/write", {
    provider: "personal",
    titleModel: null,
    version: selected.version,
  })
  expect(reset).not.toHaveProperty("titleModel")
  expect(reset.version).not.toBe(selected.version)
  expect(reset.models).toEqual(initial.models)
  expect(reset.settings).toEqual(initial.settings)
  expect(await userConfig.readConfiguration()).toEqual(before)
})

it("returns clear invalid-input RPC errors for invalid title model selections and parameters", async () => {
  const { connection, configPath } = await fixture()
  const { version } = await requestCatalog(connection, "provider/models/read", {
    provider: "personal",
  })
  const content = await readFile(configPath, "utf8")
  const valid = { provider: "personal", titleModel: "coder", version }
  for (const [params, message] of [
    [{ ...valid, titleModel: "missing" }, "not configured"],
    [{ ...valid, titleModel: "IMAGE-MODEL" }, "not a chat model"],
    [{ ...valid, titleModel: "" }, "non-empty model ID"],
    [{ ...valid, provider: "disconnected" }, "Provider is not connected"],
    [{ provider: "personal", version }, "model ID or null"],
    [{ ...valid, titleModel: 1 }, "model ID or null"],
    [{ ...valid, version: undefined }, "version is required"],
  ] as const) {
    const response = await connection.sendRequest(
      "provider/title-model/write",
      params,
    )
    expect(response).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining(message),
        data: { code: "invalid_input" },
      },
    })
  }
  expect(await readFile(configPath, "utf8")).toBe(content)
})
