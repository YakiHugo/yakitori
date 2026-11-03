import { afterEach, describe, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"
import { providerServices } from "../../src/runtime/provider-services.ts"
import { resolveProviderBackend } from "../../src/runtime/provider-backend.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"
import { pngImageBase64 } from "../fixtures/images.ts"

const profiles = [
  {
    model: "deepseek-v4-pro",
    service: "deepseek",
    baseURL: "https://api.deepseek.com",
    context: 1_048_576,
    output: 393_216,
    effort: "high",
    efforts: ["none", "low", "high", "max"],
  },
  {
    model: "glm-5.2",
    service: "glm",
    baseURL: "https://api.z.ai/api/paas/v4/",
    context: 1_000_000,
    output: 131_072,
    effort: "max",
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  ...["glm-5.1", "glm-5", "glm-4.7"].map((model) => ({
    model,
    service: "glm",
    baseURL: "https://api.z.ai/api/paas/v4/",
    context: 200_000,
    output: 131_072,
    effort: undefined,
    efforts: [],
  })),
] as const

afterEach(() => vi.restoreAllMocks())

describe("Comate models on original vendors' standard APIs", () => {
  it("adds only the five verified IDs, preserving current defaults", () => {
    expect(
      providerServices
        .find((service) => service.id === "deepseek")
        ?.models.map(({ id }) => id),
    ).toEqual(["deepseek-flash", "deepseek-v4-pro"])
    expect(
      providerServices
        .find((service) => service.id === "glm")
        ?.models.map(({ id }) => id),
    ).toEqual([
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-4.7",
    ])
  })

  it.each(
    profiles,
  )("resolves $model as text with verified tools, reasoning and capacity", async (profile) => {
    const provider = createConfiguredProvider(
      "personal",
      {
        name: "Editable label",
        service: profile.service,
        baseURL: profile.baseURL,
        wireApi: "openai_chat_completions",
        models: [{ id: profile.model }],
      },
      "unused",
    )
    try {
      const selection = { provider: "personal", model: profile.model }
      const resolved = provider.models.resolve(selection)
      expect(resolved).toMatchObject({
        inputModalities: ["text"],
        imageDetailModes: [],
        maxOutputTokens: profile.output,
        efforts: profile.efforts,
        supportsCustomTools: false,
        supportsNativeToolSearch: false,
        fileEditingToolType: "edit_write",
      })
      expect(resolved.defaultEffort).toBe(profile.effort)
      expect(provider.models.capacity(selection)).toMatchObject({
        contextWindowTokens: profile.context,
        contextWindowScope: "total",
      })
      expect(
        (await provider.models.listModels()).map(({ model }) => model),
      ).toContain(profile.model)
      const step = SessionConfiguration.create(
        {
          selection,
          workspaceRoot: "/tmp",
          enabledTools: [],
          approvalPolicy: "always_approve",
          promptCacheKey: "comate",
        },
        provider.models,
      ).resolveStep(selection, provider.models)
      expect(step.target.effort).toBe(profile.effort)
    } finally {
      await provider.close?.()
    }
  })

  it.each([
    "https://api.z.ai/api/coding/paas/v4/",
    "https://open.bigmodel.cn/api/paas/v4/",
    "https://relay.example/v1",
  ])("does not transfer standard Z.AI metadata to %s", async (baseURL) => {
    expect(
      resolveProviderBackend({
        service: "glm",
        wireApi: "openai_chat_completions",
        baseURL,
      }).chatCompletionsFlavor,
    ).toBe("generic")
    const provider = createConfiguredProvider(
      "personal",
      {
        name: "GLM",
        service: "glm",
        wireApi: "openai_chat_completions",
        baseURL,
        models: [{ id: "glm-5.2" }],
      },
      "unused",
    )
    try {
      expect(
        provider.models.capacity({ provider: "personal", model: "glm-5.2" }),
      ).toBeUndefined()
      expect(
        provider.models.resolve({ provider: "personal", model: "glm-5.2" })
          .defaultEffort,
      ).toBeUndefined()
    } finally {
      await provider.close?.()
    }
  })

  it("enriches only models reported by discovery, not unavailable presets or display-name aliases", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "glm-5" }, { id: "glm-5.2" }, { id: "glm-5.0" }],
        }),
      ),
    )
    const models = await discoverProviderModels(
      {
        name: "GLM",
        service: "glm",
        wireApi: "openai_chat_completions",
        baseURL: "https://api.z.ai/api/paas/v4/",
        models: [],
      },
      "unused",
    )
    expect(models.map(({ id }) => id).sort()).toEqual([
      "glm-5",
      "glm-5.0",
      "glm-5.2",
    ])
    expect(models.find(({ id }) => id === "glm-5")?.efforts).toEqual([])
    expect(models.find(({ id }) => id === "glm-5.2")?.inputModalities).toEqual([
      "text",
    ])
    expect(
      models.find(({ id }) => id === "glm-5.0")?.contextWindowTokens,
    ).toBeUndefined()
  })
})

const request = (model: string): ModelRequest => ({
  target: { provider: "personal", model, instructionProfileId: "default" },
  continuationScope: "same-account",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Inspect" }] }],
  tools: [
    {
      name: "inspect",
      description: "Inspect",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  toolWireProtocol: "eager",
})

async function run(profile: (typeof profiles)[number], input: ModelRequest) {
  const events: ModelStreamEvent[] = []
  for await (const event of createChatCompletionsProvider({
    apiKey: "unused",
    baseURL: profile.baseURL,
    flavor: profile.service as "deepseek" | "glm",
    model: profile.model,
  })(input))
    events.push(event)
  return events
}

const response = () =>
  new Response(
    'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )

describe("text-model wire contracts", () => {
  it.each(
    profiles,
  )("rejects images for $model before any fetch", async (profile) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const input: ModelRequest = {
      ...request(profile.model),
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: pngImageBase64 },
          ],
        },
      ],
    }
    expect((await run(profile, input)).at(-1)).toMatchObject({
      type: "failure",
      failure: {
        stage: "request_build",
        message: expect.stringContaining("text only"),
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(
    profiles,
  )("preserves original tool reasoning for $model without cross-account replay", async (profile) => {
    const bodies: Record<string, unknown>[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(
        `${profile.baseURL.replace(/\/$/, "")}/chat/completions`,
      )
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length > 1) return response()
      const chunks = [
        { reasoning_content: "first " },
        {
          reasoning_content: "second",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "inspect", arguments: "{}" },
            },
          ],
        },
      ]
      return new Response(
        `${chunks
          .map(
            (delta, i) =>
              `data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, delta, finish_reason: i === 1 ? "tool_calls" : null }] })}\n\n`,
          )
          .join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const base = request(profile.model)
    const input: ModelRequest = {
      ...base,
      target: {
        ...base.target,
        ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      },
    }
    const event = (await run(profile, input)).find(
      (event) => event.type === "response",
    )
    if (event?.type !== "response" || event.response.native === undefined)
      throw new Error("Missing native response")
    const next: ModelRequest = {
      ...input,
      messages: [
        ...input.messages,
        {
          role: "assistant",
          content: event.response.content,
          native: event.response.native,
        },
        {
          role: "tool",
          toolCallId: "call_1",
          content: [{ type: "text", text: "Seen" }],
        },
      ],
    }
    expect((await run(profile, next)).at(-1)).toMatchObject({
      type: "response",
    })
    expect(bodies[0]?.reasoning_effort).toBe(profile.effort)
    expect(bodies[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "inspect",
          description: "Inspect",
          parameters: { type: "object", properties: {} },
        },
      },
    ])
    expect(bodies[0]?.tool_choice).toBe("auto")
    expect(bodies[0]?.thinking).toEqual(
      profile.service === "glm"
        ? { type: "enabled", clear_thinking: false }
        : undefined,
    )
    expect(bodies[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "first second",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "inspect", arguments: "{}" },
          },
        ],
      }),
    )
    await run(profile, { ...next, continuationScope: "another-account" })
    expect(JSON.stringify(bodies[2])).not.toContain("first second")
  })

  it("respects explicit GLM thinking choices instead of replacing them", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response())
    const profile = profiles.find(({ model }) => model === "glm-4.7")
    if (!profile) throw new Error("Missing GLM profile")
    const input = {
      ...request(profile.model),
      providerOptions: {
        provider: "personal",
        wireApi: "openai_chat_completions" as const,
        body: { thinking: { type: "disabled", clear_thinking: true } },
      },
    }
    expect((await run(profile, input)).at(-1)).toMatchObject({
      type: "response",
    })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).thinking).toEqual(
      { type: "disabled", clear_thinking: true },
    )
  })

  it("allows a caller to clear GLM history while retaining captured effort", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response())
    const profile = profiles.find(({ model }) => model === "glm-5.2")
    if (!profile) throw new Error("Missing GLM profile")
    const base = request(profile.model)
    const input: ModelRequest = {
      ...base,
      target: { ...base.target, effort: "max" },
      providerOptions: {
        provider: "personal",
        wireApi: "openai_chat_completions",
        body: { thinking: { clear_thinking: true } },
      },
    }
    expect((await run(profile, input)).at(-1)).toMatchObject({
      type: "response",
    })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      thinking: { type: "enabled", clear_thinking: true },
      reasoning_effort: "max",
    })
  })

  it.each([
    { toolChoice: "required" as const },
    { parallelToolCalls: false },
    {
      target: {
        provider: "personal",
        model: "glm-4.7",
        instructionProfileId: "default" as const,
        effort: "high",
      },
    },
    {
      outputFormat: {
        type: "json_schema" as const,
        name: "result",
        schema: { type: "object" },
      },
    },
  ])("rejects unsupported GLM controls before network (%j)", async (override) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"))
    const profile = profiles.find(({ model }) => model === "glm-4.7")
    if (!profile) throw new Error("Missing GLM profile")
    expect(
      (await run(profile, { ...request(profile.model), ...override })).at(-1),
    ).toMatchObject({ type: "failure", failure: { stage: "request_build" } })
    expect(fetch).not.toHaveBeenCalled()
  })
})
