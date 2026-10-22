import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createProviderService } from "../../src/server/provider-service.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"

it("keeps account IDs independent of labels and explicit additional accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-provider-id-"))
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      Response.json({ data: [{ id: "local-model" }] }),
    )
  try {
    const configPath = join(root, "config.toml")
    const userConfig = createUserConfigStore({ configPath })
    const service = createProviderService({
      userConfig,
      credentialDirectory: join(root, "keys"),
      apply() {},
    })
    const result = await service.write({
      configuration: {
        name: "ChatGPT proxy",
        baseURL: "http://127.0.0.1:1/v1",
        wireApi: "openai_chat_completions",
        authentication: "none",
        models: [{ id: "local-model" }],
      },
    })
    const id = result.providers[0]?.id
    expect(id).toMatch(/^account_[a-f0-9-]+$/)
    if (!id) throw new Error("Missing account ID")
    const configuration = result.providers[0]?.configuration
    if (!configuration) throw new Error("Missing account configuration")
    await service.write({
      id,
      configuration: { ...configuration, name: "Renamed" },
    })
    const second = await service.write({ configuration })
    expect(second.providers).toHaveLength(2)
    expect(second.providers[0]?.id).toBe(id)
    expect(second.providers[0]?.configuration.name).toBe("Renamed")
    expect(second.providers[1]?.id).not.toBe(id)
    expect(
      Object.keys((await userConfig.readConfiguration()).modelProviders ?? {}),
    ).toHaveLength(2)
  } finally {
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
