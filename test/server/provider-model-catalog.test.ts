import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createModelSourceTool } from "../../src/server/model-source-tools.ts"
import { createProviderService } from "../../src/server/provider-service.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-provider-catalog-"))
  let models = [{ id: "coder", context_length: 32000 }]
  let status = 200
  let now = 1_000_000
  const requests: { key: string | undefined; path: string | undefined }[] = []
  const endpoint = createServer((request, response) => {
    requests.push({ key: request.headers.authorization, path: request.url })
    if (request.url?.split("?")[0] === "/v1/models") {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: models }))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(
      'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
  })
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve))
  cleanups.push(async () => {
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  const address = endpoint.address()
  if (!address || typeof address === "string")
    throw new Error("Missing test endpoint")
  const configuration = {
    name: "Personal",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    wireApi: "openai_chat_completions" as const,
    models: [],
  }
  const create = () => {
    const registry = createProviderRegistry({})
    const service = createProviderService({
      userConfig: createUserConfigStore({
        configPath: join(directory, "config.toml"),
      }),
      credentialDirectory: join(directory, "keys"),
      now: () => now,
      catalogTtlMs: 1000,
      apply: (providers) => registry.replace(providers),
    })
    return { registry, service }
  }
  return {
    ...create(),
    create,
    directory,
    configuration,
    requests,
    models: (next: typeof models) => {
      models = next
    },
    status: (value: number) => {
      status = value
    },
    advance: () => {
      now += 1001
    },
  }
}

it("refreshes automatic models without copying discovery into the user's configuration", async () => {
  const f = await fixture()
  await f.service.write({
    id: "personal",
    configuration: f.configuration,
    apiKey: "first",
  })
  f.models([
    { id: "coder", context_length: 64000 },
    { id: "new-coder", context_length: 128000 },
  ])
  f.advance()
  await f.registry.models("personal").refresh()
  expect(
    (await f.registry.models("personal").listModels()).map(
      (model) => model.model,
    ),
  ).toEqual(["coder", "new-coder"])
  expect(
    f.registry
      .models("personal")
      .capacity({ provider: "personal", model: "coder" })?.contextWindowTokens,
  ).toBe(64000)
  expect((await f.service.read()).providers[0]?.configuration.models).toEqual(
    [],
  )
  expect(
    await readFile(join(f.directory, "config.toml"), "utf8"),
  ).not.toContain("new-coder")
  f.status(503)
  const restarted = f.create()
  await restarted.service.reload()
  expect(
    (await restarted.registry.models("personal").listModels()).map(
      (model) => model.model,
    ),
  ).toEqual(["coder", "new-coder"])
  expect(f.requests).toHaveLength(2)
  f.advance()
  await restarted.registry.models("personal").refresh()
  expect(
    (await restarted.registry.models("personal").listModels()).map(
      (model) => model.model,
    ),
  ).toEqual(["coder", "new-coder"])
  expect(
    (await restarted.service.read()).providers[0]?.catalog?.error,
  ).toContain("HTTP 503")
  const files = await readdir(join(f.directory, "provider-models"))
  if (process.platform !== "win32")
    expect(
      (await stat(join(f.directory, "provider-models", files[0] ?? ""))).mode &
        0o777,
    ).toBe(0o600)
})

it("keeps selected model overrides through refresh and preserves an explicitly empty selection", async () => {
  const f = await fixture()
  await f.service.write({
    id: "personal",
    configuration: f.configuration,
    apiKey: "first",
  })
  await f.service.write({
    id: "personal",
    configuration: {
      ...f.configuration,
      modelSelection: "selected",
      models: [
        { id: "coder", displayName: "My coder", contextWindowTokens: 16000 },
      ],
    },
  })
  f.models([
    { id: "coder", context_length: 64000 },
    { id: "new-coder", context_length: 128000 },
  ])
  await f.service.refreshModels("personal")
  expect(
    (await f.registry.models("personal").listModels()).map((model) => [
      model.model,
      model.displayName,
    ]),
  ).toEqual([["coder", "My coder"]])
  expect(
    f.registry
      .models("personal")
      .capacity({ provider: "personal", model: "coder" })?.contextWindowTokens,
  ).toBe(16000)
  await f.service.write({
    id: "personal",
    configuration: {
      ...f.configuration,
      modelSelection: "selected",
      models: [],
    },
  })
  expect(await f.registry.models("personal").listModels()).toEqual([])
  const restarted = f.create()
  await restarted.service.reload()
  expect(await restarted.registry.models("personal").listModels()).toEqual([])
})

it("isolates catalog and connection results when credentials change", async () => {
  const f = await fixture()
  await f.service.write({
    id: "personal",
    configuration: f.configuration,
    apiKey: "first",
  })
  const client = f.registry.createClient()
  const turn = client.startTurn("personal", { maxAttempts: 1 })
  f.models([{ id: "other-account-model", context_length: 48000 }])
  await f.service.write({
    id: "personal",
    configuration: f.configuration,
    apiKey: "second",
  })
  expect(
    (await f.registry.models("personal").listModels()).map(
      (model) => model.model,
    ),
  ).toEqual(["other-account-model"])
  expect(f.requests.map((request) => request.key)).toEqual([
    "Bearer first",
    "Bearer second",
  ])
  try {
    for await (const _event of turn.stream({
      target: {
        provider: "personal",
        model: "coder",
        instructionProfileId: "default",
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      system: [],
      tools: [],
      toolWireProtocol: "eager",
    })) {
      /* Consume the captured transport. */
    }
  } finally {
    await turn.close()
    await client.close()
  }
  expect((await f.service.read()).providers[0]?.connection).toBeUndefined()
  expect(f.requests.at(-1)?.key).toBe("Bearer first")
})

it("previews without a write and restores model-authored changes after restart without exposing keys", async () => {
  const f = await fixture()
  const tool = createModelSourceTool(f.service)
  const preview = await tool.execute(
    {
      action: "preview",
      name: "Preview",
      base_url: f.configuration.baseURL,
      api_key: "private",
    },
    { workspaceRoot: f.directory },
  )
  expect(preview.ok).toBe(true)
  expect(JSON.stringify(preview)).not.toContain("private")
  expect((await f.service.read()).providers).toEqual([])
  await expect(readdir(join(f.directory, "keys"))).rejects.toMatchObject({
    code: "ENOENT",
  })
  await f.service.write({
    id: "personal",
    configuration: f.configuration,
    apiKey: "private",
  })
  const changed = await f.service.write({
    id: "personal",
    configuration: { ...f.configuration, enabled: false },
    apiKey: "replacement",
  })
  const restarted = f.create()
  await restarted.service.reload()
  if (!changed.undoId) throw new Error("Missing undo token")
  const restored = await createModelSourceTool(restarted.service).execute(
    { action: "restore", undo_id: changed.undoId },
    { workspaceRoot: f.directory },
  )
  expect(restored.ok).toBe(true)
  expect(JSON.stringify(restored)).not.toContain("private")
  expect(
    (await restarted.service.read()).providers[0]?.configuration.enabled,
  ).toBeUndefined()
  expect(restarted.registry.providers).toEqual(["personal"])
  await restarted.service.write({
    id: "personal",
    configuration: { ...f.configuration, name: "Edited later" },
  })
  await expect(restarted.service.restore(changed.undoId)).rejects.toThrow(
    "changed after",
  )
})

it("persists source order and removes disabled connections from routing", async () => {
  const f = await fixture()
  await f.service.write({
    id: "first",
    configuration: f.configuration,
    apiKey: "one",
  })
  await f.service.write({
    id: "second",
    configuration: f.configuration,
    apiKey: "two",
  })
  await f.service.move("second", "first")
  const restarted = f.create()
  await restarted.service.reload()
  expect(
    (await restarted.service.read()).providers.map((provider) => provider.id),
  ).toEqual(["second", "first"])
  await restarted.service.write({
    id: "second",
    configuration: { ...f.configuration, enabled: false },
  })
  expect(restarted.registry.providers).toEqual(["first"])
  expect(
    (await restarted.service.read()).providers.map((provider) => provider.id),
  ).toEqual(["second", "first"])
})

it("does not carry a connection's successful status to a changed endpoint from the config file", async () => {
  const f = await fixture()
  await f.service.write({
    id: "personal",
    configuration: f.configuration,
    apiKey: "first",
  })
  await f.service.test({ id: "personal", configuration: f.configuration })
  expect((await f.service.read()).providers[0]?.connection?.state).toBe("ready")
  const config = createUserConfigStore({
    configPath: join(f.directory, "config.toml"),
  })
  await config.writeValue({
    keyPath: ["model_providers", "personal", "base_url"],
    value: f.configuration.baseURL.replace("/v1", "/other/v1"),
  })
  await f.service.reload()
  expect((await f.service.read()).providers[0]?.connection).toBeUndefined()
})

it("refreshes with current discovery semantics after a preset-only change", async () => {
  const f = await fixture()
  await f.service.write({
    id: "personal",
    configuration: f.configuration,
    apiKey: "same-key",
  })
  await f.service.write({
    id: "personal",
    configuration: {
      ...f.configuration,
      preset: "siliconflow",
      models: [{ id: "coder" }],
    },
  })
  await f.service.refreshModels("personal")
  expect(f.requests.at(-1)).toEqual({
    key: "Bearer same-key",
    path: "/v1/models?sub_type=chat",
  })
  const restarted = f.create()
  await restarted.service.reload()
  await restarted.service.write({
    id: "personal",
    configuration: { ...f.configuration, models: [{ id: "coder" }] },
  })
  await restarted.service.refreshModels("personal")
  expect(f.requests.at(-1)?.path).toBe("/v1/models")
})

it("refreshes auth headers when no-key mode changes without changing the stored key", async () => {
  const f = await fixture()
  // API keys are opaque: this value is also the no-key mode placeholder.
  await f.service.write({
    id: "personal",
    configuration: { ...f.configuration, noKey: true },
    apiKey: "local-no-key",
  })
  expect(f.requests.at(-1)?.key).toBeUndefined()
  await f.service.write({
    id: "personal",
    configuration: {
      ...f.configuration,
      noKey: false,
      models: [{ id: "coder" }],
    },
  })
  await f.service.refreshModels("personal")
  expect(f.requests.at(-1)).toEqual({
    key: "Bearer local-no-key",
    path: "/v1/models",
  })
})
