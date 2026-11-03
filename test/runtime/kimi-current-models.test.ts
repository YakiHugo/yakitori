import sharp from "sharp"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import type {
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
} from "../../src/runtime/model.ts"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"

const apiModels = ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"] as const
const codeModels = ["k3.1-pro", "k3.1-pro-highspeed"] as const
afterEach(() => vi.unstubAllGlobals())

function configured(model: string, service: "moonshot" | "kimi-code") {
  const bodies: string[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected serialized SDK JSON")
    bodies.push(init.body)
    const events =
      service === "moonshot"
        ? [
            {
              type: "response.completed",
              response: {
                id: "resp_test",
                status: "completed",
                output: [],
                incomplete_details: null,
                error: null,
              },
            },
          ]
        : [
            {
              type: "message_start",
              message: {
                id: "msg_test",
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]
    return new Response(
      events
        .map(
          (event) =>
            `${service === "kimi-code" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  vi.stubGlobal("fetch", fetchFn)
  const provider = createConfiguredProvider(
    "renamed-account",
    {
      name: "Renamed account",
      service,
      baseURL:
        service === "moonshot"
          ? "https://api.moonshot.ai/v1"
          : "https://api.kimi.com/coding",
      wireApi:
        service === "moonshot" ? "openai_responses" : "anthropic_messages",
      models: [{ id: model }],
    },
    "test-no-network",
  )
  const session = provider.startTurn({ maxAttempts: 1 })
  onTestFinished(async () => {
    await session.close()
    await provider.close?.()
  })
  const selection = { provider: "renamed-account", model }
  const configuration = SessionConfiguration.create(
    {
      selection,
      workspaceRoot: "/workspace",
      enabledTools: [],
      approvalPolicy: "always_approve",
      promptCacheKey: "kimi-current-images",
    },
    session.models,
  ).resolveStep(selection, session.models)
  if (session.serviceId === undefined || session.wireApi === undefined)
    throw new Error(
      "Configured native session must capture service and protocol",
    )
  const step = captureStepContext({
    registry: createToolRegistry([]),
    configuration,
    serviceId: session.serviceId,
    wireApi: session.wireApi,
    nativePdf: session.nativePdf === true,
    ...(session.toolCapabilities === undefined
      ? {}
      : { toolCapabilities: session.toolCapabilities }),
  })
  const send = async (messages: readonly ModelMessage[], system = "") => {
    const projected = await prepareModelMedia(messages, {
      target: step.target,
      imageCapabilities: step.modelInfo,
      deferImagePreparation: step.deferImagePreparation,
      rolloutAssets: undefined,
      documentReading: step.documentReading,
      userDocumentReading: step.userDocumentReading,
    })
    const request: ModelRequest = {
      target: step.target,
      system: [{ id: "base", revision: "1", text: system }],
      messages: projected,
      tools: [
        {
          name: "inspect",
          description: "Inspect an image",
          inputSchema: { type: "object" },
        },
      ],
      toolWireProtocol: "eager",
    }
    const events: ModelStreamEvent[] = []
    for await (const event of session.stream(request)) events.push(event)
    return events
  }
  return { bodies, session, step, send }
}
async function sourceImage() {
  return sharp({
    create: { width: 2400, height: 100, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer()
}
function history(source: Buffer): ModelMessage[] {
  const image = {
    type: "image" as const,
    mediaType: "image/jpeg" as const,
    detail: "high" as const,
    data: source.toString("base64"),
  }
  return [
    { role: "user", content: [image] },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call_image", name: "inspect", input: {} },
      ],
    },
    { role: "tool", toolCallId: "call_image", content: [image] },
  ]
}
function wireImages(value: unknown): Buffer[] {
  if (Array.isArray(value)) return value.flatMap(wireImages)
  if (typeof value !== "object" || value === null) return []
  const item = value as Record<string, unknown>
  if (item.type === "input_image" && typeof item.image_url === "string")
    return [
      Buffer.from(
        item.image_url.slice(item.image_url.indexOf(",") + 1),
        "base64",
      ),
    ]
  if (
    item.type === "base64" &&
    typeof item.media_type === "string" &&
    item.media_type.startsWith("image/") &&
    typeof item.data === "string"
  )
    return [Buffer.from(item.data, "base64")]
  return Object.values(item).flatMap(wireImages)
}

describe("current Kimi API and Code model routing", () => {
  it.each(
    apiModels,
  )("sends %s user and tool images through its captured native API policy", async (model) => {
    const { step, send, bodies } = configured(model, "moonshot")
    expect(step.target.effort).toBe("max")
    expect(step.modelInfo.inputModalities).toContain("image")
    expect(step.deferImagePreparation).toBe(true)
    const source = await sourceImage()
    const messages = history(source)
    const before = structuredClone(messages)
    const events = await send(messages)
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("response")
    expect(bodies).toHaveLength(1)
    const body = JSON.parse(bodies[0] ?? "{}")
    expect(body).toMatchObject({ model, reasoning: { effort: "max" } })
    const images = wireImages(body)
    expect(images).toHaveLength(2)
    for (const image of images) expect(image.equals(source)).toBe(true)
    expect(messages).toEqual(before)
  })

  it.each(
    apiModels,
  )("retains the complete 20 MB API image budget for %s", async (model) => {
    const { send, bodies } = configured(model, "moonshot")
    const events = await send(
      history(await sourceImage()),
      "a".repeat(20_000_000),
    )
    expect(bodies).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request", stage: "request_build" },
    })
    expect(JSON.stringify(events)).toContain("20 MB")
  })

  it.each([
    "kimi-k3.1-pro-latest",
    "k3.1-pro",
    "kimi-k3.1-pro-highspeed-preview",
  ])("does not broaden exact API IDs to %s", async (model) => {
    const { send, bodies } = configured(model, "moonshot")
    const events = await send(history(await sourceImage()))
    expect(bodies).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request", stage: "request_build" },
    })
    expect(JSON.stringify(events)).toContain("exact public API model ID")
  })

  it.each(
    codeModels,
  )("keeps %s Code metadata and high effort with native client image preparation", async (model) => {
    const { step, session, send, bodies } = configured(model, "kimi-code")
    expect(step.target).toMatchObject({
      instructionProfileId: "kimi-code",
      effort: "high",
    })
    expect(step.modelInfo.inputModalities).toEqual(["text", "image", "video"])
    expect(step.modelInfo.efforts).toEqual(["low", "high", "max"])
    expect(session.models.capacity(step.target)?.contextWindowTokens).toBe(
      model === "k3.1-pro" ? 262144 : 1048576,
    )
    expect(step.deferImagePreparation).toBe(true)
    const messages = history(await sourceImage())
    const before = structuredClone(messages)
    const events = await send(messages)
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("response")
    expect(bodies).toHaveLength(1)
    const body = JSON.parse(bodies[0] ?? "{}")
    expect(body).toMatchObject({ model, output_config: { effort: "high" } })
    const images = wireImages(body)
    expect(images).toHaveLength(2)
    for (const image of images)
      expect((await sharp(image).metadata()).width).toBe(2000)
    expect(messages).toEqual(before)
  })

  it.each(
    codeModels.flatMap((model) =>
      ["effort", "native"].map((mode) => ({ model, mode })),
    ),
  )("rejects disabled thinking for $model via $mode before preparing assets", async ({
    model,
    mode,
  }) => {
    const { step, session, bodies } = configured(model, "kimi-code")
    const { effort: _effort, ...target } = step.target
    let reads = 0
    const request: ModelRequest = {
      target: mode === "effort" ? { ...target, effort: "off" } : target,
      system: [],
      tools: [],
      toolWireProtocol: "eager",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              file: { rolloutId: "rollout_test", path: "source.png" },
              sizeBytes: 0,
            },
          ],
        },
      ],
      assets: {
        read: async () => {
          reads += 1
          throw new Error("must reject before asset preparation")
        },
      },
      ...(mode === "native"
        ? {
            providerOptions: {
              provider: target.provider,
              wireApi: "anthropic_messages" as const,
              body: { thinking: { type: "disabled" } },
            },
          }
        : {}),
    }
    const events: ModelStreamEvent[] = []
    for await (const event of session.stream(request)) events.push(event)
    expect(reads).toBe(0)
    expect(bodies).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { kind: "invalid_request", stage: "request_build" },
    })
  })

  it("retains explicit thinking off for the older kimi-for-coding model", async () => {
    const { step, session, bodies } = configured("kimi-for-coding", "kimi-code")
    const events: ModelStreamEvent[] = []
    for await (const event of session.stream({
      target: { ...step.target, effort: "off" },
      system: [],
      tools: [],
      toolWireProtocol: "eager",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }))
      events.push(event)
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("response")
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
      model: "kimi-for-coding",
      thinking: { type: "disabled" },
    })
  })

  it("does not impose the Moonshot image request budget on Code", async () => {
    const { send, bodies } = configured("k3.1-pro", "kimi-code")
    const events = await send(
      history(await sourceImage()),
      "a".repeat(20_000_000),
    )
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("response")
    expect(bodies).toHaveLength(1)
    expect(Buffer.byteLength(bodies[0] ?? "")).toBeGreaterThan(20_000_000)
  })
})
