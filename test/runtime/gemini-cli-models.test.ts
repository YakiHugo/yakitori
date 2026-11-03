import { afterEach, expect, it, vi } from "vitest"
import { createConfiguredModelsManager } from "../../src/runtime/configured-models-manager.ts"
import { adaptImagesForModel } from "../../src/runtime/model-images.ts"
import type { ModelMessage, ModelRequest } from "../../src/runtime/model.ts"
import { providerPresets } from "../../src/runtime/provider-presets.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"
import { discoverProviderModels } from "../../src/server/provider-model-discovery.ts"
import { pngImageBase64 } from "../fixtures/images.ts"

afterEach(() => vi.unstubAllGlobals())

const configuration = {
  name: "Personal account",
  service: "gemini",
  wireApi: "gemini_generate_content",
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  models: [],
} as const
const current = [
  "gemini-3.8-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
]
const legacy = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3-pro-preview",
  "gemini-3.1-flash-lite-preview",
]
const unknown = [
  "gemini-3-flash",
  "gemini-3-future-text",
  "gemini-embedding-001",
  "gemma-3-1b-it",
  "auto",
  "flash",
  "none",
]
const image = {
  type: "image",
  mediaType: "image/png",
  data: pngImageBase64,
  detail: "high",
} as const

it("offers current API models from Gemini CLI without retired models or CLI routing aliases", () => {
  const preset = providerPresets.find((entry) => entry.id === "gemini")
  expect(preset?.models.map((model) => model.id)).toEqual(current)
})

it.each([
  "gemini_generate_content",
  "gemini_interactions",
] as const)("enriches only exact %s models returned by the account's native catalog", async (wireApi) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        models: [...current, ...legacy, ...unknown].map((model) => ({
          name: `models/${model}`,
          inputTokenLimit: 12345,
          outputTokenLimit: 6789,
          supportedGenerationMethods: ["generateContent"],
        })),
      }),
    ),
  )
  const discovered = await discoverProviderModels(
    { ...configuration, wireApi },
    "test",
  )
  for (const id of [...current, ...legacy]) {
    expect(discovered.find((entry) => entry.id === id)).toMatchObject({
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
      defaultVisible: !legacy.includes(id),
      contextWindowTokens: 12345,
      contextWindowScope: "input",
      maxOutputTokens: 6789,
    })
  }
  for (const id of unknown) {
    expect(
      discovered.find((entry) => entry.id === id)?.inputModalities,
    ).toBeUndefined()
  }
  const custom = await discoverProviderModels(
    {
      ...configuration,
      wireApi,
      baseURL: "https://compatible.example/v1beta",
    },
    "test",
  )
  expect(custom.every((model) => model.inputModalities === undefined)).toBe(
    true,
  )
  expect(discovered).toHaveLength(
    current.length + legacy.length + unknown.length,
  )
})

it("repairs saved native visual defaults while preserving explicit capability and visibility choices", async () => {
  const manager = createConfiguredModelsManager({
    provider: "personal",
    serviceId: "gemini",
    wireApi: "gemini_generate_content",
    models: [
      ...[...current, ...legacy, ...unknown].map((id) => ({
        id,
        defaultVisible: true,
      })),
    ],
  })
  const listed = await manager.listModels()
  for (const id of [...current, ...legacy]) {
    const target = {
      provider: "personal",
      model: id,
      instructionProfileId: "default" as const,
    }
    const resolved = manager.resolve(target)
    expect(resolved.inputModalities).toEqual(["text", "image"])
    expect(
      adaptImagesForModel(
        [{ role: "user", content: [image] }],
        target,
        resolved,
      ).omittedImageCount,
    ).toBe(0)
    expect(listed.some((entry) => entry.model === id)).toBe(
      !legacy.includes(id),
    )
  }
  for (const id of unknown) {
    expect(
      manager.resolve({ provider: "personal", model: id }).inputModalities,
    ).toEqual(["text"])
  }
  const explicit = createConfiguredModelsManager({
    provider: "personal",
    serviceId: "gemini",
    wireApi: "gemini_generate_content",
    models: [
      {
        id: "gemini-2.5-pro",
        visible: true,
        inputModalities: ["text"],
        imageDetailModes: [],
      },
    ],
  })
  expect(await explicit.listModels()).toMatchObject([
    { model: "gemini-2.5-pro", inputModalities: ["text"] },
  ])
  const custom = createConfiguredProvider(
    "personal",
    {
      ...configuration,
      baseURL: "https://compatible.example/v1beta",
      models: [{ id: "gemini-3.1-pro-preview" }],
    },
    "test",
  )
  expect(
    custom.models.resolve({
      provider: "personal",
      model: "gemini-3.1-pro-preview",
    }).inputModalities,
  ).toEqual(["text"])
})

it.each([
  ...current,
  "gemini-2.5-pro",
  "gemini-2.5-flash",
])("sends saved %s user and tool images through the real native adapter", async (model) => {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      expect(String(url)).toContain(
        `/models/${model}:streamGenerateContent?alt=sse`,
      )
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      return new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [{ text: "Seen" }] },
              finishReason: "STOP",
            },
          ],
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    }),
  )
  const registry = createProviderRegistry({
    personal: createConfiguredProvider(
      "personal",
      {
        ...configuration,
        models: [{ id: model }],
      },
      "test",
    ),
  })
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "Inspect" }, image] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call", name: "inspect", input: {} }],
    },
    { role: "tool", toolCallId: "call", content: [image] },
  ]
  const before = structuredClone(messages)
  const request: ModelRequest = {
    target: { provider: "personal", model, instructionProfileId: "default" },
    system: [],
    messages,
    tools: [],
    toolWireProtocol: "eager",
  }
  try {
    const events = await Array.fromAsync(registry.stream(request))
    expect(events.at(-1)?.type).toBe("response")
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.generationConfig).not.toHaveProperty("candidateCount")
    expect(bodies[0]).toHaveProperty("contents.0.parts.1.inlineData", {
      mimeType: "image/png",
      data: pngImageBase64,
    })
    const nested =
      !model.startsWith("gemma-") && !model.startsWith("gemini-2.5-")
    expect(bodies[0]).toHaveProperty(
      nested
        ? "contents.2.parts.0.functionResponse.parts.0.inlineData.data"
        : "contents.2.parts.2.inlineData.data",
      pngImageBase64,
    )
    expect(messages).toEqual(before)
  } finally {
    await registry.close()
  }
})

it("refuses unknown text models and invalid Gemma thinking before a network request", async () => {
  const fetchFn = vi.fn()
  vi.stubGlobal("fetch", fetchFn)
  const registry = createProviderRegistry({
    personal: createConfiguredProvider(
      "personal",
      {
        ...configuration,
        models: [{ id: "gemini-3-future-text" }, { id: "gemma-4-31b-it" }],
      },
      "test",
    ),
  })
  try {
    for (const [model, effort, providerCode] of [
      ["gemini-3-future-text", undefined, "unsupported_modality"],
      ["gemma-4-31b-it", "medium", "unsupported_effort"],
    ] as const) {
      const events = await Array.fromAsync(
        registry.stream({
          target: {
            provider: "personal",
            model,
            instructionProfileId: "default",
            ...(effort ? { effort } : {}),
          },
          messages: [{ role: "user", content: [image] }],
          system: [],
          tools: [],
          toolWireProtocol: "eager",
        }),
      )
      expect(events.at(-1)).toMatchObject({
        type: "failure",
        failure: {
          kind: "invalid_request",
          stage: "request_build",
          providerCode,
        },
      })
    }
    expect(fetchFn).not.toHaveBeenCalled()
  } finally {
    await registry.close()
  }
})
