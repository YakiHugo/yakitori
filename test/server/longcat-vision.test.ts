import sharp from "sharp"
import { afterEach, expect, it, vi } from "vitest"
import { createChatCompletionsProvider } from "../../src/runtime/chat-completions-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { providerServices } from "../../src/runtime/provider-services.ts"
import type { ModelRequest } from "../../src/runtime/model.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import {
  gifImageBase64,
  jpegImageBase64,
  pngImageBase64,
  pngImageBytes,
  webpImageBase64,
} from "../fixtures/images.ts"

const target = {
  provider: "personal",
  model: "LongCat-2.5",
  instructionProfileId: "default" as const,
}
const endpoint = "https://api.longcat.chat/openai/v1"
const image = {
  type: "image" as const,
  mediaType: "image/png" as const,
  data: pngImageBase64,
}
const request: ModelRequest = {
  target,
  system: [
    {
      id: "system",
      revision: "test",
      text: "System instructions stay above user input.",
    },
  ],
  tools: [],
  toolWireProtocol: "eager",
  messages: [{ role: "user", content: [image] }],
}
function provider(
  baseURL = endpoint,
  service = "longcat",
  model = target.model,
) {
  return createConfiguredProvider(
    target.provider,
    {
      name: "Personal account",
      service,
      baseURL,
      wireApi: "openai_chat_completions",
      models: [{ id: model }],
    },
    "fixture-key",
  )
}
function stream() {
  return createChatCompletionsProvider({
    baseURL: endpoint,
    apiKey: "fixture-key",
    model: target.model,
    flavor: "longcat",
  })
}
function response() {
  return new Response(
    `${[
      {
        id: "chat",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "private reasoning" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat",
        choices: [
          {
            index: 0,
            delta: { content: "Image answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}
afterEach(() => vi.restoreAllMocks())

it("publishes only the verified Chat model, with parameter-reference capacity", async () => {
  expect(
    providerServices.find((service) => service.id === "longcat"),
  ).toMatchObject({
    baseURL: endpoint,
    envKey: "LONGCAT_API_KEY",
    wireApi: "openai_chat_completions",
    models: [
      {
        id: target.model,
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 262_144,
      },
    ],
  })
  const registry = createProviderRegistry(
    { [target.provider]: provider() },
    {
      settings: () => ({
        [target.model]: {
          instructionProfileId: "kimi-code",
          efforts: ["max"],
          speeds: ["fast"],
          inputModalities: ["video"],
          imageDetailModes: ["original"],
        },
      }),
    },
  )
  try {
    expect(registry.models(target.provider).resolve(target)).toMatchObject({
      toolPolicy: "chat_only",
      shellToolType: "disabled",
      fileEditingToolType: "none",
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
      efforts: [],
      speeds: [],
      instructions: expect.stringContaining("cannot call tools"),
    })
  } finally {
    await registry.close()
  }
})

it.each([
  ["https://relay.example/v1", "longcat"],
  ["https://api.longcat.chat/openai/v1/proxy", "longcat"],
  [endpoint, "openrouter"],
])("does not grant a service contract to a renamed or relayed endpoint: %s", async (url, service) => {
  const p = provider(url, service)
  expect(p.models.resolve(target).toolPolicy).toBeUndefined()
  await p.close?.()
})

it("preserves JPEG/PNG/WebP/GIF and public URLs, omits undocumented controls, and keeps instructions above user content", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response())
  const registry = createProviderRegistry({
    [target.provider]: provider(`${endpoint}/`),
  })
  const images = [
    { ...image, data: jpegImageBase64, mediaType: "image/jpeg" as const },
    image,
    { ...image, data: webpImageBase64, mediaType: "image/webp" as const },
    { ...image, data: gifImageBase64, mediaType: "image/gif" as const },
  ]
  const messages: ModelRequest["messages"] = [
    {
      role: "developer",
      content: [{ type: "text", text: "Keep developer instruction role." }],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Describe these images" },
        ...images,
        {
          type: "image",
          mediaType: "image/png",
          file: { url: "https://images.example/original.png" },
          sizeBytes: 0,
        },
      ],
    },
  ]
  const before = structuredClone(messages)
  try {
    const events = await Array.fromAsync(
      registry.stream({ ...request, messages, maxOutputTokens: 4096 }),
    )
    expect(events.at(-1)).toMatchObject({
      type: "response",
      response: {
        native: [],
        content: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: "Image answer" },
        ],
      },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(String(url)).toBe(`${endpoint}/chat/completions`)
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture-key",
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      model: target.model,
      stream: true,
      max_tokens: 4096,
      messages: [
        {
          role: "system",
          content: "System instructions stay above user input.",
        },
        { role: "system", content: "Keep developer instruction role." },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe these images" },
            ...images.map((image) => ({
              type: "image_url",
              image_url: {
                url: `data:${image.mediaType};base64,${image.data}`,
              },
            })),
            {
              type: "image_url",
              image_url: { url: "https://images.example/original.png" },
            },
          ],
        },
      ],
    })
    expect(messages).toEqual(before)
    const answer = events.at(-1)
    if (answer?.type !== "response") throw new Error("Missing response")
    await Array.fromAsync(
      registry.stream({
        ...request,
        messages: [
          ...messages,
          {
            role: "assistant",
            content: answer.response.content,
            native: answer.response.native ?? [],
          },
          { role: "user", content: [{ type: "text", text: "Continue" }] },
        ],
      }),
    )
    const secondBody = String(fetch.mock.calls[1]?.[1]?.body)
    expect(secondBody).not.toContain("private reasoning")
    expect(JSON.parse(secondBody).messages.at(-2)).toEqual({
      role: "assistant",
      content: "Image answer",
    })
  } finally {
    await registry.close()
  }
})

it.each([
  "LongCat-Flash-Chat",
  "LongCat-2.5-Preview",
  "LongCat-unknown",
])("rejects unverified model %s before sending", async (model) => {
  const fetch = vi.spyOn(globalThis, "fetch")
  const events = await Array.fromAsync(
    stream()({ ...request, target: { ...target, model } }),
  )
  expect(events.at(-1)?.type).toBe("failure")
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  {
    tools: [
      { name: "exec", description: "Run", inputSchema: { type: "object" } },
    ],
  },
  {
    providerOptions: {
      provider: target.provider,
      wireApi: "openai_chat_completions" as const,
      body: { thinking: { type: "disabled" } },
    },
  },
  {
    outputFormat: {
      type: "json_schema" as const,
      name: "answer",
      schema: { type: "object" },
    },
  },
  { target: { ...target, effort: "high" as const } },
  {
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "document" as const,
            name: "private.pdf",
            mediaType: "application/pdf" as const,
            data: "JVBERi0xLjc=",
            sizeBytes: 8,
            file: { rolloutId: "rollout", path: "private.pdf" },
          },
        ],
      },
    ],
  },
  {
    messages: [
      {
        role: "tool" as const,
        toolCallId: "call",
        content: [{ type: "text" as const, text: "Tool output" }],
      },
    ],
  },
])("rejects unsupported controls and tool history without mutating or sending: %j", async (overrides) => {
  const fetch = vi.spyOn(globalThis, "fetch")
  const input = { ...request, ...overrides }
  const before = structuredClone(input)
  const events = await Array.fromAsync(stream()(input))
  expect(events.at(-1)?.type).toBe("failure")
  expect(fetch).not.toHaveBeenCalled()
  expect(input).toEqual(before)
})

it("counts the 50-image limit across history and public URL blocks before reading assets", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response())
  const fifty = Array.from({ length: 50 }, () => image)
  const valid = await Array.fromAsync(
    stream()({ ...request, messages: [{ role: "user", content: fifty }] }),
  )
  expect(valid.at(-1)?.type).toBe("response")
  fetch.mockClear()
  const events = await Array.fromAsync(
    stream()({
      ...request,
      messages: [
        { role: "user", content: fifty },
        { role: "assistant", content: [{ type: "text", text: "Previous" }] },
        {
          role: "user",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              sizeBytes: 0,
              file: { url: "https://images.example/one.png" },
            },
          ],
        },
      ],
    }),
  )
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: { message: expect.stringContaining("at most 50") },
  })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  200, 201,
])("admits 200:1 and rejects 201:1 in both orientations (%i)", async (ratio) => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response())
  for (const [width, height] of [
    [ratio, 1],
    [1, ratio],
  ]) {
    const data = (
      await sharp({
        create: {
          width: width ?? 1,
          height: height ?? 1,
          channels: 3,
          background: "red",
        },
      })
        .png()
        .toBuffer()
    ).toString("base64")
    const events = await Array.fromAsync(
      stream()({
        ...request,
        messages: [{ role: "user", content: [{ ...image, data }] }],
      }),
    )
    expect(events.at(-1)?.type).toBe(ratio === 200 ? "response" : "failure")
  }
  expect(fetch).toHaveBeenCalledTimes(ratio === 200 ? 2 : 0)
})

it.each([
  10_000_000, 10_000_001,
])("enforces the decoded 10 MB image limit (%i)", async (size) => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response())
  const events = await Array.fromAsync(
    stream()({
      ...request,
      messages: [
        {
          role: "user",
          content: [{ ...image, data: pngImageBytes(size).toString("base64") }],
        },
      ],
    }),
  )
  expect(events.at(-1)?.type).toBe(size === 10_000_000 ? "response" : "failure")
  expect(fetch).toHaveBeenCalledTimes(size === 10_000_000 ? 1 : 0)
})

it("includes encoded history and escaped text in its explicit local request guard", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
  const events = await Array.fromAsync(
    stream()({
      ...request,
      messages: [
        {
          role: "user",
          content: [image, { type: "text", text: "\n".repeat(16_000_000) }],
        },
      ],
    }),
  )
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: { message: expect.stringContaining("local 32 MB") },
  })
  expect(fetch).not.toHaveBeenCalled()
})

it("rejects a surprise tool call instead of completing chat-only execution", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"exec","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  )
  const events = await Array.fromAsync(stream()(request))
  expect(events.some((event) => event.type === "response")).toBe(false)
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: { kind: "protocol_error" },
  })
})

it("stops loading later assets when repeated originals exceed the local encoded request budget", async () => {
  const bytes = pngImageBytes(9_000_000)
  const read = vi.fn(async () => bytes)
  const fetch = vi.spyOn(globalThis, "fetch")
  const events = await Array.fromAsync(
    stream()({
      ...request,
      assets: { read },
      messages: [
        {
          role: "user",
          content: Array.from({ length: 4 }, (_, index) => ({
            type: "image" as const,
            mediaType: "image/png" as const,
            sizeBytes: bytes.length,
            file: { rolloutId: "rollout", path: `image-${index}.png` },
          })),
        },
      ],
    }),
  )
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: { message: expect.stringContaining("local 32 MB") },
  })
  expect(read).toHaveBeenCalledTimes(3)
  expect(fetch).not.toHaveBeenCalled()
})
