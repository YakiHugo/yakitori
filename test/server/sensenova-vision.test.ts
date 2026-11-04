import { afterEach, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import type { ModelRequest } from "../../src/runtime/model.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { sensenovaVisionModel } from "../../src/runtime/sensenova-vision.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { pngImageBase64 } from "../fixtures/images.ts"

const target = {
  provider: "renamed",
  model: sensenovaVisionModel,
  instructionProfileId: "default" as const,
}
function provider(
  baseURL = "https://token.sensenova.cn/v1",
  service = "sensenova",
  model = sensenovaVisionModel,
) {
  return createConfiguredProvider(
    target.provider,
    {
      name: "Renamed",
      service,
      baseURL,
      wireApi: "openai_chat_completions",
      models: [
        {
          id: model,
          inputModalities: ["text", "image", "video"],
          efforts: ["max"],
          imageDetailModes: ["original"],
        },
      ],
    },
    "fixture-key",
  )
}
const request: ModelRequest = {
  target,
  system: [],
  tools: [],
  toolWireProtocol: "eager",
  messages: [
    {
      role: "user",
      content: [
        { type: "image", mediaType: "image/png", data: pngImageBase64 },
      ],
    },
  ],
}
function response(finish = true) {
  const chunks = [
    {
      id: "chat",
      choices: [
        {
          index: 0,
          delta: { reasoning: "private reasoning" },
          finish_reason: "",
        },
      ],
    },
    {
      id: "chat",
      choices: [
        { index: 0, delta: { content: "The picture" }, finish_reason: "" },
      ],
    },
    ...(finish
      ? [
          {
            id: "chat",
            choices: [
              {
                index: 0,
                delta: { content: " is red." },
                finish_reason: "stop",
              },
            ],
          },
        ]
      : []),
    {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
  ]
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}
afterEach(() => vi.restoreAllMocks())

it.each([
  "https://token.sensenova.cn/v1",
  "https://token.sensenova.ai/v1",
])("restricts the documented regional service %s despite editable settings", async (baseURL) => {
  const registry = createProviderRegistry(
    { [target.provider]: provider(baseURL) },
    {
      settings: () => ({
        [target.model]: {
          instructionProfileId: "kimi-code",
          efforts: ["high"],
          speeds: ["fast"],
          inputModalities: ["video"],
          imageDetailModes: ["original"],
        },
      }),
    },
  )
  try {
    const models = registry.models(target.provider)
    const model = models.resolve(target)
    expect(model).toMatchObject({
      toolPolicy: "chat_only",
      shellToolType: "disabled",
      fileEditingToolType: "none",
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
      efforts: [],
      speeds: [],
    })
    expect(model.instructions).toContain("cannot call tools")
    const config = SessionConfiguration.create(
      {
        selection: target,
        workspaceRoot: "/tmp",
        enabledTools: ["exec_command"],
        approvalPolicy: "always_approve",
        promptCacheKey: "fixture",
      },
      models,
    )
    expect(
      captureStepContext({
        configuration: config.resolveStep(target, models),
        registry: createToolRegistry([]),
        serviceId: "sensenova",
        wireApi: "openai_chat_completions",
      }).deferImagePreparation,
    ).toBe(true)
  } finally {
    await registry.close()
  }
})

it.each([
  ["https://relay.example/v1", "sensenova"],
  ["https://token.sensenova.cn/proxy/v1", "sensenova"],
  ["https://token.sensenova.ai/v1", "openrouter"],
])("does not infer a vendor contract from a label: %s", async (url, service) => {
  const p = provider(url, service)
  expect(p.models.resolve(target).toolPolicy).toBeUndefined()
  await p.close?.()
})

it.each([
  "https://token.sensenova.cn/v1",
  "https://token.sensenova.ai/v1",
])("preserves multi-image originals and completes two reasoning turns without replay at %s", async (baseURL) => {
  const { default: sharp } = await import("sharp")
  const original = (
    await sharp({
      create: { width: 3000, height: 8, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer()
  ).toString("base64")
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response())
  const registry = createProviderRegistry({
    [target.provider]: provider(baseURL),
  })
  try {
    const firstRequest = {
      ...request,
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "image" as const,
              mediaType: "image/jpeg" as const,
              data: original,
            },
            {
              type: "image" as const,
              mediaType: "image/png" as const,
              data: pngImageBase64,
            },
          ],
        },
      ],
    }
    const first = await Array.fromAsync(registry.stream(firstRequest))
    const answer = first.find((event) => event.type === "response")
    if (answer?.type !== "response") throw new Error(JSON.stringify(first))
    expect(answer.response.content).toContainEqual({
      type: "text",
      text: "The picture is red.",
    })
    expect(answer.response.content).toContainEqual({
      type: "reasoning",
      text: "private reasoning",
    })
    expect(answer.response.native).toEqual([])
    const history = [
      ...firstRequest.messages,
      {
        role: "assistant" as const,
        content: answer.response.content,
        ...(answer.response.native === undefined
          ? {}
          : { native: answer.response.native }),
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Explain further" }],
      },
    ]
    const before = structuredClone(history)
    const second = await Array.fromAsync(
      registry.stream({ ...request, messages: history }),
    )
    expect(second.at(-1)?.type).toBe("response")
    expect(history).toEqual(before)
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toBe(`${baseURL}/chat/completions`)
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture-key",
      )
      const body = JSON.parse(String(init?.body))
      for (const field of [
        "tools",
        "tool_choice",
        "stream_options",
        "reasoning_effort",
      ])
        expect(body).not.toHaveProperty(field)
      expect(body.messages[0].content).toEqual([
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${original}` },
        },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${pngImageBase64}` },
        },
      ])
      expect(String(init?.body)).not.toContain("private reasoning")
    }
    expect(
      JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages[1],
    ).toEqual({ role: "assistant", content: "The picture is red." })
  } finally {
    await registry.close()
  }
})

it("does not treat an empty finish reason or DONE as successful completion", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(false))
  const stream = createChatCompletionsProvider({
    apiKey: "fixture",
    baseURL: "https://token.sensenova.cn/v1",
    model: target.model,
    flavor: "sensenova",
  })
  const events = await Array.fromAsync(stream(request))
  expect(events.some((event) => event.type === "response")).toBe(false)
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: { kind: "stream_disconnected" },
  })
})

it.each([
  "sensenova-6.7-flash-lite",
  "sensenova-u1-fast",
])("rejects retired or unverified models without sending: %s", async (model) => {
  const fetch = vi.spyOn(globalThis, "fetch")
  const registry = createProviderRegistry({
    [target.provider]: provider(undefined, undefined, model),
  })
  try {
    const events = await Array.fromAsync(
      registry.stream({ ...request, target: { ...target, model } }),
    )
    expect(events.at(-1)?.type).toBe("failure")
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await registry.close()
  }
})

it.each([
  {
    tools: [
      {
        name: "mutate",
        description: "mutate",
        inputSchema: { type: "object" },
      },
    ],
  },
  {
    providerOptions: {
      provider: target.provider,
      wireApi: "openai_chat_completions" as const,
      body: { tools: [] },
    },
  },
  {
    outputFormat: {
      type: "json_schema" as const,
      name: "answer",
      schema: { type: "object" },
    },
  },
])("rejects unverified controls before a request: %j", async (overrides) => {
  const fetch = vi.spyOn(globalThis, "fetch")
  const registry = createProviderRegistry({ [target.provider]: provider() })
  try {
    const events = await Array.fromAsync(
      registry.stream({ ...request, ...overrides }),
    )
    expect(events.at(-1)?.type).toBe("failure")
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await registry.close()
  }
})

it("fails closed if the service emits a tool call in chat-only execution", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"mutate","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  )
  const registry = createProviderRegistry({ [target.provider]: provider() })
  try {
    const events = await Array.fromAsync(registry.stream(request))
    expect(events.some((event) => event.type === "response")).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "protocol_error" },
    })
  } finally {
    await registry.close()
  }
})

it("never replays portable reasoning from an earlier generic connection", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response())
  const stream = createChatCompletionsProvider({
    apiKey: "fixture",
    baseURL: "https://token.sensenova.cn/v1",
    model: target.model,
    flavor: "sensenova",
  })
  const messages: ModelRequest["messages"] = [
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "old private reasoning",
          providerMetadata: {
            chatCompletions: {
              provider: target.provider,
              scope: "owner",
              reasoningContent: true,
            },
          },
        },
        { type: "text", text: "previous answer" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ]
  const before = structuredClone(messages)
  const events = await Array.fromAsync(
    stream({ ...request, messages, continuationScope: "owner" }),
  )
  expect(events.at(-1)?.type).toBe("response")
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
  expect(body.messages[0]).toEqual({
    role: "assistant",
    content: "previous answer",
  })
  expect(messages).toEqual(before)
})

it("rejects opaque reasoning-native history without silently rewriting it", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
  const p = provider()
  const registry = createProviderRegistry({ [target.provider]: p })
  const messages: ModelRequest["messages"] = [
    {
      role: "assistant",
      content: [{ type: "text", text: "previous answer" }],
      native: [
        {
          provider: target.provider,
          model: target.model,
          wireApi: "openai_chat_completions",
          value: {
            role: "assistant",
            content: "previous answer",
            reasoning: "opaque",
          },
        },
      ],
    },
  ]
  const before = structuredClone(messages)
  try {
    const events = await Array.fromAsync(
      registry.stream({ ...request, messages }),
    )
    expect(events.at(-1)?.type).toBe("failure")
    expect(fetch).not.toHaveBeenCalled()
    expect(messages).toEqual(before)
  } finally {
    await registry.close()
  }
})
