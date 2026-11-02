import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prepareGrokImage } from "../../src/runtime/grok-image-policy.ts"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import type { ModelImageBlock, ModelRequest } from "../../src/runtime/model.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { captureStepContext } from "../../src/runtime/tools/spec-plan.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createConfiguredProvider } from "../../src/server/configured-provider.ts"

afterEach(() => vi.restoreAllMocks())
const image = async (format: "png" | "jpeg" | "webp" = "png") =>
  sharp({ create: { width: 3000, height: 20, channels: 3, background: "red" } })
    [format]()
    .toBuffer()

describe("direct Grok image policy", () => {
  it.each([
    "png",
    "jpeg",
  ] as const)("keeps original %s bytes and pixels", async (format) => {
    const bytes = await image(format)
    expect((await prepareGrokImage(bytes)).data).toBe(bytes.toString("base64"))
  })
  it("rejects undocumented formats and oversized images without changing them", async () => {
    await expect(prepareGrokImage(await image("webp"))).rejects.toThrow(
      "JPEG and PNG",
    )
    await expect(
      prepareGrokImage(Buffer.alloc(20 * 1024 * 1024 + 1)),
    ).rejects.toThrow("20 MiB")
    await expect(prepareGrokImage(Buffer.from("broken"))).rejects.toThrow()
  })
  it.each([
    { native: true, model: "grok-4.7", width: 3000 },
    { native: false, model: "grok-4.7", width: 2048 },
    { native: true, model: "grok-4.7-unverified", width: 2048 },
  ])("projects history and tool images only for captured direct model ($native, $model)", async ({
    native,
    model,
    width,
  }) => {
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      bodies.push(String(options?.body))
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":null}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const provider = createConfiguredProvider(
      "personal",
      {
        name: "Editable label",
        service: "xai",
        wireApi: "openai_responses",
        baseURL: native ? "https://api.x.ai/v1" : "https://relay.example/v1",
        models: [{ id: model, inputModalities: ["text", "image"] }],
      },
      "unused",
    )
    const turn = createProviderRegistry({ personal: provider })
      .createClient()
      .startTurn("personal")
    const selection = { provider: "personal", model }
    const configuration = SessionConfiguration.create(
      {
        selection,
        workspaceRoot: "/tmp",
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: "grok-images",
      },
      provider.models,
    ).resolveStep(selection, provider.models)
    const step = captureStepContext({
      registry: createToolRegistry([]),
      configuration,
      ...(turn.serviceId === undefined ? {} : { serviceId: turn.serviceId }),
      ...(turn.wireApi === undefined ? {} : { wireApi: turn.wireApi }),
    })
    const bytes = await image()
    const block: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      data: bytes.toString("base64"),
    }
    try {
      const messages = await prepareModelMedia(
        [
          { role: "user", content: [block] },
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "call_1", name: "inspect", input: {} },
            ],
          },
          { role: "tool", toolCallId: "call_1", content: [block] },
        ],
        {
          target: step.target,
          deferImagePreparation: step.deferImagePreparation,
          imageCapabilities: step.modelInfo,
          rolloutAssets: undefined,
          documentReading: step.documentReading,
          userDocumentReading: step.userDocumentReading,
        },
      )
      const request: ModelRequest = {
        target: step.target,
        system: [],
        messages,
        tools: [],
        toolWireProtocol: "eager",
      }
      const events = await Array.fromAsync(turn.stream(request))
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({
        type: "response",
      })
      const urls =
        bodies[0]?.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? []
      expect(urls).toHaveLength(2)
      for (const url of urls) {
        const payload = Buffer.from(url.split(",")[1] ?? "", "base64")
        expect((await sharp(payload).metadata()).width).toBe(width)
        if (width === 3000) expect(payload).toEqual(bytes)
      }
      expect(block.data).toBe(bytes.toString("base64"))
      if (native && model === "grok-4.7") {
        const prior = bodies.length
        const failed = await Array.fromAsync(
          turn.stream({
            ...request,
            system: [
              {
                id: "large",
                revision: "1",
                text: "a".repeat(32 * 1024 * 1024),
              },
            ],
          }),
        )
        expect(failed.at(-1)).toMatchObject({
          type: "failure",
          failure: { kind: "invalid_request" },
        })
        expect(bodies).toHaveLength(prior)
        const unsupported = await Array.fromAsync(
          turn.stream({
            ...request,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    mediaType: "image/webp",
                    data: (await image("webp")).toString("base64"),
                  },
                ],
              },
            ],
          }),
        )
        expect(unsupported.at(-1)).toMatchObject({
          type: "failure",
          failure: { kind: "invalid_request" },
        })
        expect(bodies).toHaveLength(prior)
      }
    } finally {
      await provider.close?.()
    }
  })
})
