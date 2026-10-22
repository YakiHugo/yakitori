import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { ModelSettingsConfiguration } from "../../src/protocol/providers.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createModelSettingsManager } from "../../src/runtime/model-settings-manager.ts"
import { createDiscoveringModelsManager } from "../../src/runtime/models-manager.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createProviderService } from "../../src/server/provider-service.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-model-settings-"))
  let settings: ModelSettingsConfiguration = {}
  let upstream = [
    {
      id: "new-coder",
      efforts: ["low", "high"],
      defaultEffort: "high",
      contextWindowTokens: 100000,
    },
  ]
  let requests = 0
  const source = createDiscoveringModelsManager({
    provider: "codex",
    identity: async () => "account",
    discover: async () => {
      requests++
      return upstream
    },
  })
  const registry = createProviderRegistry(
    {
      codex: createModelProvider({
        info: {
          id: "codex",
          wireApi: "openai_responses",
          capabilities: { remoteCompaction: false },
        },
        models: source,
        stream: async function* () {},
      }),
    },
    { settings: (provider) => settings[provider] ?? {} },
  )
  const userConfig = createUserConfigStore({
    configPath: join(directory, "config.toml"),
  })
  const service = createProviderService({
    userConfig,
    credentialDirectory: join(directory, "keys"),
    registry: () => registry,
    modelSettingsChanged: (value) => {
      settings = value
    },
    apply: () => {},
  })
  cleanups.push(async () => {
    await registry.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    directory,
    userConfig,
    service,
    registry,
    requests: () => requests,
    discoverMore: () => {
      upstream = [
        ...upstream,
        {
          id: "later-coder",
          efforts: ["low", "high"],
          defaultEffort: "high",
          contextWindowTokens: 200000,
        },
      ]
    },
  }
}

it("persists user visibility and capabilities separately and applies them without rebuilding a connection", async () => {
  const f = await fixture()
  const initial = await f.service.readModels("codex")
  await f.service.writeModels(
    "codex",
    {
      "new-coder": { visible: false },
      "manual-coder": {
        contextWindowTokens: 64000,
        inputModalities: ["text", "image"],
        efforts: ["low", "high"],
        defaultEffort: "low",
      },
    },
    initial.version,
  )
  expect(
    (await f.registry.models("codex").listModels()).map((model) => model.model),
  ).toEqual(["manual-coder"])
  expect(
    f.registry
      .models("codex")
      .capacity({ provider: "codex", model: "manual-coder" })
      ?.contextWindowTokens,
  ).toBe(64000)
  f.discoverMore()
  await f.service.refreshCatalog("codex")
  expect(f.requests()).toBe(2)
  expect(
    (await f.registry.models("codex").listModels()).map((model) => model.model),
  ).toEqual(["later-coder", "manual-coder"])
  const restarted = createUserConfigStore({
    configPath: join(f.directory, "config.toml"),
  })
  expect(
    (await restarted.readConfiguration()).models?.codex?.["manual-coder"]
      ?.defaultEffort,
  ).toBe("low")
  const contents = await readFile(join(f.directory, "config.toml"), "utf8")
  expect(contents).not.toContain("model_providers")
  expect(contents).not.toContain("later-coder")
})

it("allows an inherited reasoning list and rejects stale or invalid user writes", async () => {
  const f = await fixture()
  const initial = await f.service.readModels("codex")
  const written = await f.service.writeModels(
    "codex",
    { "new-coder": { defaultEffort: "low" } },
    initial.version,
  )
  expect(written.settings["new-coder"]).toEqual({ defaultEffort: "low" })
  await expect(
    f.service.writeModels(
      "codex",
      { "new-coder": { defaultEffort: "invalid" } },
      written.version,
    ),
  ).rejects.toThrow("not supported")
  await expect(
    f.service.writeModels("codex", {}, initial.version),
  ).rejects.toThrow("modified since last read")
  expect(
    f.registry
      .models("codex")
      .resolve({ provider: "codex", model: "new-coder" }).defaultEffort,
  ).toBe("low")
})

it("keeps a partial effort override effective after reading persisted settings", async () => {
  const f = await fixture()
  const initial = await f.service.readModels("codex")
  const written = await f.service.writeModels(
    "codex",
    { "new-coder": { efforts: ["low"] } },
    initial.version,
  )
  expect(
    written.models.find((model) => model.id === "new-coder"),
  ).toMatchObject({
    id: "new-coder",
    efforts: ["low", "high"],
    defaultEffort: "high",
  })
  expect(written.settings["new-coder"]).toEqual({ efforts: ["low"] })
  const [effective] = await f.registry.models("codex").listModels()
  expect(effective?.efforts).toEqual(["low"])
  expect(effective?.defaultEffort).toBeUndefined()
  expect(
    f.registry
      .models("codex")
      .resolve({ provider: "codex", model: "new-coder" }).defaultEffort,
  ).toBeUndefined()

  const restarted = createUserConfigStore({
    configPath: join(f.directory, "config.toml"),
  })
  const settings = (await restarted.readConfiguration()).models?.codex ?? {}
  expect(settings["new-coder"]).toEqual({ efforts: ["low"] })
  const source = createDiscoveringModelsManager({
    provider: "codex",
    identity: async () => "account",
    discover: async () => [
      { id: "new-coder", efforts: ["low", "high"], defaultEffort: "high" },
    ],
  })
  const restored = createModelSettingsManager(source, () => settings)
  const [listed] = await restored.listModels()
  expect(listed?.efforts).toEqual(["low"])
  expect(listed?.defaultEffort).toBeUndefined()
  expect(
    restored.resolve({ provider: "codex", model: "new-coder" }).defaultEffort,
  ).toBeUndefined()
})
