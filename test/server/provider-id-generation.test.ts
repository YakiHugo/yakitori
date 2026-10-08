import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createProviderService } from "../../src/server/provider-service.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"

it("generates a usable connection id when the display name starts with a reserved prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-provider-id-"))
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "local-model" }] })),
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
        noKey: true,
        models: [{ id: "local-model" }],
      },
    })
    expect(result.providers[0]?.id).toBe("provider-chatgpt-proxy")
    expect(
      (await userConfig.readConfiguration()).modelProviders,
    ).toHaveProperty("provider-chatgpt-proxy")
  } finally {
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

