import { afterEach, expect, it, vi } from "vitest"
import {
  createChatCompletionsProvider,
  toChatCompletionsMessages,
} from "../../src/runtime/chat-completions-provider.ts"
import type { ModelRequest } from "../../src/runtime/model.ts"
import { pngImageBase64 } from "../fixtures/images.ts"

afterEach(() => vi.restoreAllMocks())

const nativeEndpoints = [
  {
    flavor: "stepfun",
    baseURL: "https://api.stepfun.com/step_plan/v1",
    model: "step-3.7",
    tokenField: "max_tokens",
  },
  {
    flavor: "mimo",
    baseURL: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.6-pro",
    tokenField: "max_completion_tokens",
  },
  {
    flavor: "sensenova",
    baseURL: "https://token.sensenova.ai/v1",
    model: "sensenova-6.8-flash-lite",
    tokenField: "max_tokens",
  },
  {
    flavor: "longcat",
    baseURL: "https://api.longcat.chat/openai/v1",
    model: "LongCat-2.5",
    tokenField: "max_tokens",
  },
  {
    flavor: "reka",
    baseURL: "https://api.reka.ai/v1",
    model: "reka-edge-2603",
    tokenField: "max_tokens",
  },
  {
    flavor: "spark",
    baseURL: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
    model: "spark-x2.5",
    tokenField: "max_completion_tokens",
  },
  {
    flavor: "glm",
    baseURL: "https://api.z.ai/api/paas/v4",
    model: "glm-5.2",
    tokenField: "max_tokens",
  },
] as const

it.each(
  nativeEndpoints,
)("keeps $flavor token fields request-local and omits stream_options", async (endpoint) => {
  const bodies = captureBodies()
  const stream = createChatCompletionsProvider({
    ...endpoint,
    baseURL: `${endpoint.baseURL}/`,
    apiKey: "unused",
  })
  for (const maxOutputTokens of [1024, undefined]) {
    const events = await Array.fromAsync(
      stream({
        ...request(endpoint.model),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: "response" })
  }
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toHaveProperty(endpoint.tokenField, 1024)
  for (const body of bodies) expect(body).not.toHaveProperty("stream_options")
  const otherField =
    endpoint.tokenField === "max_tokens"
      ? "max_completion_tokens"
      : "max_tokens"
  expect(bodies[0]).not.toHaveProperty(otherField)
  expect(bodies[1]).not.toHaveProperty("max_tokens")
  expect(bodies[1]).not.toHaveProperty("max_completion_tokens")
})

it.each(
  nativeEndpoints,
)("keeps generic wire fields outside the verified $flavor endpoint", async (endpoint) => {
  const bodies = captureBodies()
  for (const options of [
    { ...endpoint, baseURL: "https://relay.example/v1" },
    { ...endpoint, baseURL: `${endpoint.baseURL}?relay=1` },
    { ...endpoint, baseURL: `${endpoint.baseURL}//` },
    { ...endpoint, flavor: "generic" as const },
  ]) {
    const events = await Array.fromAsync(
      createChatCompletionsProvider({ ...options, apiKey: "unused" })({
        ...request(endpoint.model),
        maxOutputTokens: 1024,
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: "response" })
  }
  expect(bodies).toHaveLength(4)
  for (const body of bodies) {
    expect(body).toMatchObject({
      max_tokens: 1024,
      stream_options: { include_usage: true },
    })
    expect(body).not.toHaveProperty("max_completion_tokens")
  }
})

it.each([
  "glm-5.3-flash",
  "glm-5.3",
  "glm-custom",
])("does not apply the GLM text dialect to %s", async (model) => {
  const bodies = captureBodies()
  const events = await Array.fromAsync(
    createChatCompletionsProvider({
      flavor: "glm",
      baseURL: "https://api.z.ai/api/paas/v4",
      model,
      apiKey: "unused",
    })(request(model)),
  )
  expect(events.at(-1)).toMatchObject({ type: "response" })
  expect(bodies[0]).toHaveProperty("stream_options", { include_usage: true })
})

it.each([
  { flavor: "generic", detail: "high" },
  { flavor: "qwen", detail: undefined },
  { flavor: "glm", detail: undefined },
  { flavor: "tencent", detail: undefined },
  { flavor: "reka", detail: undefined },
  { flavor: "mimo", detail: undefined },
] as const)("serializes $flavor detail consistently for user and tool images", ({
  flavor,
  detail,
}) => {
  const image = {
    type: "image",
    mediaType: "image/png",
    data: pngImageBase64,
  } as const
  const messages = toChatCompletionsMessages(
    [
      { role: "user", content: [image] },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call", name: "inspect", input: {} },
        ],
      },
      { role: "tool", toolCallId: "call", content: [image] },
    ],
    "personal",
    undefined,
    flavor,
  )
  const images = messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : [],
  )
  expect(images).toHaveLength(2)
  for (const part of images) {
    expect(part).toEqual({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${pngImageBase64}`,
        ...(detail === undefined ? {} : { detail }),
      },
    })
  }
})

it.each([
  "sensenova",
  "longcat",
] as const)("omits detail in portable %s user image chat", (flavor) => {
  expect(
    toChatCompletionsMessages(
      [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: pngImageBase64 },
          ],
        },
      ],
      "personal",
      undefined,
      flavor,
    ),
  ).toEqual([
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${pngImageBase64}` },
        },
      ],
    },
  ])
})

function request(model: string): ModelRequest {
  return {
    target: { provider: "personal", model, instructionProfileId: "default" },
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    toolWireProtocol: "eager",
  }
}

function captureBodies(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)))
    return new Response(
      'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  return bodies
}
