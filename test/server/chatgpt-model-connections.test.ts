import { describe, expect, it, vi } from "vitest"
import type { ChatGPTPlanAccess } from "../../src/runtime/chatgpt-plan-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createChatGPTModelConnections } from "../../src/server/chatgpt-model-connections.ts"
import { createModelDirectory } from "../../src/server/model-directory.ts"

const account = { clientId: "oaiapp_fake", subject: "fake-account-a" }
const providerId = "chatgpt-connection-a"
const target = { provider: providerId, model: "gpt-5.4" }
const request: ModelRequest = {
  target: { ...target, instructionProfileId: "default" },
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  toolWireProtocol: "meta_dispatch",
}

function catalog(ids = ["gpt-5.4"]) {
  return Response.json({
    models: ids.map((id) => ({
      slug: id,
      display_name: id,
      visibility: "list",
    })),
  })
}

function completed() {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "fake-response",
        model: "gpt-5.4",
        status: "completed",
        output: [],
        error: null,
        incomplete_details: null,
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe("ChatGPT model connections", () => {
  it("lazily lists only account models in server order without Codex capability guesses", async () => {
    const resolve = vi.fn(async (identity: typeof account) => ({
      ...identity,
      accessToken: `fake-${identity.subject}`,
    }))
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/models")
      expect(init?.redirect).toBe("error")
      const token = new Headers(init?.headers).get("authorization")
      return token === "Bearer fake-fake-account-a"
        ? Response.json({
            models: [
              {
                slug: "future-model",
                display_name: "First",
                visibility: "list",
              },
              { slug: "hidden", display_name: "Hidden", visibility: "hide" },
              { slug: "gpt-5.4", display_name: "Second", visibility: "list" },
            ],
          })
        : catalog(["account-b-only"])
    })
    const connections = createChatGPTModelConnections({ resolve, fetchFn })
    const provider = connections.provider(account, providerId)
    const other = connections.provider(
      { ...account, subject: "fake-account-b" },
      "chatgpt-connection-b",
    )
    expect(fetchFn).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    const registry = createProviderRegistry({
      [providerId]: provider,
      "chatgpt-connection-b": other,
    })
    const directory = createModelDirectory(registry)
    const listed = await directory.listModels(providerId)
    expect(listed.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: "future-model", displayName: "First" },
      { id: "gpt-5.4", displayName: "Second" },
    ])
    expect(listed[1]).toMatchObject({
      instructionProfileId: "default",
      efforts: [],
      inputModalities: ["text"],
      imageDetailModes: [],
    })
    expect(listed[1]).not.toHaveProperty("effectiveContextWindowTokens")
    expect(provider.models.resolve(target)).toMatchObject({
      supportsNativeToolSearch: false,
      supportsCustomTools: false,
    })
    expect(provider.models.capacity(target)).toBeUndefined()
    expect(() =>
      provider.models.validate({ ...target, effort: "high" }),
    ).toThrow("not supported")
    expect(() =>
      provider.models.resolve({ ...target, model: "hidden" }),
    ).toThrow("not configured")
    expect(
      (await directory.listModels("chatgpt-connection-b")).map(({ id }) => id),
    ).toEqual(["account-b-only"])
    expect(provider.models.resolve(target).model).toBe("gpt-5.4")
  })

  it("coalesces concurrent discovery and fails closed without a static catalog fallback", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let failed = false
    const fetchFn = vi.fn<typeof fetch>(async () => {
      await gate
      return failed ? new Response(null, { status: 401 }) : catalog()
    })
    const provider = createChatGPTModelConnections({
      resolve: async () => ({ ...account, accessToken: "fake-access" }),
      fetchFn,
    }).provider(account, providerId)
    const first = provider.models.listModels()
    const second = provider.models.refresh()
    release()
    await Promise.all([first, second])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    failed = true
    await expect(provider.models.listModels()).rejects.toThrow(
      "ChatGPT models are unavailable",
    )
    failed = false
    await expect(provider.models.listModels()).resolves.toHaveLength(1)
  })

  it("rejects a changed account before discovery or inference can transmit anything", async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const provider = createChatGPTModelConnections({
      resolve: async () => ({
        ...account,
        subject: "unexpected-account",
        accessToken: "fake-other-token",
      }),
      fetchFn,
    }).provider(account, providerId)
    await expect(provider.models.listModels()).rejects.toThrow(
      "ChatGPT models are unavailable",
    )
    const turn = provider.startTurn({ maxAttempts: 1 })
    try {
      expect(await collect(turn.stream(request))).toContainEqual(
        expect.objectContaining({
          type: "failure",
          failure: expect.objectContaining({
            kind: "authentication",
            providerCode: "chatgpt_account_changed",
          }),
        }),
      )
      expect(fetchFn).not.toHaveBeenCalled()
    } finally {
      await turn.close()
    }
  })

  it("does not install an in-flight model catalog after registration revocation", async () => {
    const controller = new AbortController()
    const provider = createChatGPTModelConnections({
      resolve: async () => ({
        ...account,
        accessToken: "fake-access",
        signal: controller.signal,
      }),
      fetchFn: async () => {
        controller.abort()
        return catalog()
      },
    }).provider(account, providerId)
    await expect(provider.models.refresh()).rejects.toThrow()
    expect(() => provider.models.resolve(target)).toThrow("not configured")
  })

  it("retains the old account for active Turns while new Turns use the replacement", async () => {
    const calls: string[] = []
    let suffix = "one"
    const resolve = vi.fn(
      async (identity: typeof account): Promise<ChatGPTPlanAccess> => ({
        ...identity,
        accessToken: `fake-${identity.subject}-${suffix}`,
      }),
    )
    const connections = createChatGPTModelConnections({
      resolve,
      fetchFn: async (_url, init) => {
        calls.push(new Headers(init?.headers).get("authorization") ?? "")
        return completed()
      },
    })
    const provider = connections.provider(account, providerId)
    const registry = createProviderRegistry({ [providerId]: provider })
    const client = registry.createClient()
    const oldTurn = client.startTurn(providerId)
    try {
      await collect(oldTurn.stream(request))
      suffix = "two"
      registry.replace({
        [providerId]: connections.provider(
          { ...account, subject: "fake-account-b" },
          providerId,
        ),
      })
      await collect(oldTurn.stream(request))
      await collect(client.startTurn(providerId).stream(request))
      expect(calls).toEqual([
        "Bearer fake-fake-account-a-one",
        "Bearer fake-fake-account-a-two",
        "Bearer fake-fake-account-b-two",
      ])
      expect(oldTurn.warmup).toBeUndefined()
      expect(oldTurn.remoteCompaction).toBe(false)
      expect(oldTurn.nativePdf).toBe(false)
      expect(() =>
        oldTurn.stream({ ...request, compaction: "codex_remote" }),
      ).toThrow("does not support remote compaction")
      expect(calls).toHaveLength(3)
    } finally {
      await client.close()
    }
  })
})
