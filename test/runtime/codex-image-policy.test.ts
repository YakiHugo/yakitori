import { createStaticModelsManager } from "../../src/runtime/models-manager.ts"
import type OpenAI from "openai"
import sharp from "sharp"
import { expect, it } from "vitest"
import { inspectImageBytes } from "../../src/kernel/image-metadata.ts"
import {
  prepareCodexImage,
  validateCodexImageRequest,
  CODEX_IMAGE_REQUEST_SAFETY_BYTES,
} from "../../src/runtime/codex-image-policy.ts"
import { createOpenAIProvider } from "../../src/runtime/openai-provider.ts"
import { discoverCodexModels } from "../../src/runtime/model-discovery.ts"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
} from "../../src/runtime/model.ts"
import { withSDKResponse } from "../support/sdk-response.ts"

async function fixture(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: "red" } })
    .png()
    .toBuffer()
}
function image(
  bytes: Buffer,
  detail: "high" | "original" = "high",
): ModelImageBlock {
  return {
    type: "image",
    data: bytes.toString("base64"),
    mediaType: "image/png",
    detail,
  }
}

it.each([
  [2048, 2048, "high", 1600, 1600],
  [4096, 1024, "high", 2048, 512],
  [4000, 4000, "original", 3200, 3200],
  [8000, 1000, "original", 6000, 750],
] as const)("prepares %sx%s %s within Codex edge and 32px patch budgets", async (w, h, detail, width, height) => {
  const bytes = await fixture(w, h)
  const before = Buffer.from(bytes)
  const prepared = await prepareCodexImage(bytes, image(bytes, detail))
  expect(
    inspectImageBytes(Buffer.from(prepared.data ?? "", "base64")),
  ).toMatchObject({ width, height })
  expect(prepared.detail).toBe(detail)
  expect(bytes).toEqual(before)
})

it("preserves an in-budget original byte-for-byte and honors cancellation", async () => {
  const bytes = await fixture(3000, 1000)
  expect((await prepareCodexImage(bytes, image(bytes, "original"))).data).toBe(
    bytes.toString("base64"),
  )
  const abort = new AbortController()
  abort.abort(new Error("cancelled"))
  await expect(
    prepareCodexImage(bytes, image(bytes), abort.signal),
  ).rejects.toThrow("cancelled")
})

it("guards the exact encoded request including non-image content", () => {
  expect(() =>
    validateCodexImageRequest({
      input: [],
      instructions: "a".repeat(CODEX_IMAGE_REQUEST_SAFETY_BYTES),
    }),
  ).toThrow("local Codex image request budget")
  expect(() =>
    validateCodexImageRequest({ input: [], instructions: "你好" }),
  ).not.toThrow()
})

it.each(
  ["gpt-6.1-sol", "gpt-6.1-terra"].flatMap((model) => [
    { model, supportsOriginal: true, bundled: true },
    { model, supportsOriginal: true, bundled: false },
    { model, supportsOriginal: false, bundled: false },
  ]),
)("projects $model historical originals using bundled=$bundled original=$supportsOriginal and sends user/tool images", async ({
  model,
  supportsOriginal,
  bundled,
}) => {
  const bytes = await fixture(2048, 2048)
  const messages: ModelMessage[] = [
    { role: "user", content: [image(bytes, "original")] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "call",
          name: "view_image",
          input: { path: "image.png" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call",
      content: [
        {
          type: "image",
          mediaType: "image/png",
          detail: "original",
          sizeBytes: bytes.length,
          file: { rolloutId: "historical", path: "image.png" },
        },
      ],
    },
  ]
  const history = JSON.stringify(messages)
  const target = {
    provider: "renamed-codex",
    model,
    instructionProfileId: model,
  }
  const discovered = bundled
    ? []
    : await discoverCodexModels({
        baseUrl: "https://chatgpt.example/backend-api/codex",
        accessToken: "test",
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: target.model,
                  input_modalities: ["text", "image"],
                  supports_image_detail_original: supportsOriginal,
                  shell_type: "shell_command",
                  apply_patch_tool_type: "freeform",
                },
              ],
            }),
          ),
      })
  const capabilities = bundled
    ? createStaticModelsManager("renamed-codex", "codex").resolve(target)
    : discovered[0]?.capabilities
  expect(capabilities?.imageDetailModes).toEqual(
    supportsOriginal ? ["high", "original"] : ["high"],
  )
  if (capabilities === undefined)
    throw new Error("Missing discovered capabilities")
  const projected = await prepareModelMedia(messages, {
    deferImagePreparation: true,
    target,
    imageCapabilities: capabilities,
    rolloutAssets: undefined,
    documentReading: { nativePdf: false, images: true },
    userDocumentReading: { nativePdf: false, images: true },
  })
  const bodies: unknown[] = []
  const client = withSDKResponse({
    responses: {
      async create(body: unknown) {
        bodies.push(body)
        return (async function* () {
          yield {
            type: "response.completed",
            response: { id: "r", status: "completed", output: [] },
          }
        })()
      },
    },
  } as unknown as OpenAI)
  const stream = createOpenAIProvider({
    apiKey: "test",
    model: target.model,
    requestProfile: "codex",
    client,
  })
  const request: ModelRequest = {
    target,
    system: [],
    messages: projected,
    assets: {
      async read() {
        return bytes
      },
      url() {
        return "https://assets.invalid/image.png"
      },
    },
    tools: [],
    toolWireProtocol: "openai_deferred",
  }
  const events = await Array.fromAsync(stream(request))
  expect(events.some((event) => event.type === "failure")).toBe(false)
  expect(bodies).toHaveLength(1)
  const body = bodies[0] as {
    input: {
      content?: { type: string; image_url: string; detail: string }[]
      output?: { type: string; image_url: string; detail: string }[]
    }[]
  }
  const images = body.input
    .flatMap((item) => item.content ?? item.output ?? [])
    .filter((block) => block.type === "input_image")
  expect(images).toHaveLength(2)
  for (const block of images) {
    expect(block.detail).toBe(supportsOriginal ? "original" : "high")
    expect(
      inspectImageBytes(
        Buffer.from(block.image_url.split(",")[1] ?? "", "base64"),
      ),
    ).toMatchObject({
      width: supportsOriginal ? 2048 : 1600,
      height: supportsOriginal ? 2048 : 1600,
    })
  }
  expect(JSON.stringify(messages)).toBe(history)
})

it("normalizes oriented JPEG pixels and converts GIF to static PNG only in the request", async () => {
  const jpeg = await sharp({
    create: { width: 4096, height: 1024, channels: 3, background: "red" },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
  const prepared = await prepareCodexImage(jpeg, {
    ...image(jpeg),
    mediaType: "image/jpeg",
  })
  const output = Buffer.from(prepared.data ?? "", "base64")
  expect(inspectImageBytes(output)).toMatchObject({
    mediaType: "image/jpeg",
    width: 512,
    height: 2048,
  })
  expect((await sharp(jpeg).metadata()).orientation).toBe(6)
  expect((await sharp(output).metadata()).orientation).toBeUndefined()
  const gif = await sharp(await fixture(64, 64))
    .gif()
    .toBuffer()
  const gifImage = await prepareCodexImage(gif, {
    ...image(gif, "original"),
    mediaType: "image/gif",
  })
  expect(gifImage.mediaType).toBe("image/png")
  expect(
    inspectImageBytes(Buffer.from(gifImage.data ?? "", "base64")),
  ).toMatchObject({ width: 64, height: 64 })
  expect(inspectImageBytes(gif).mediaType).toBe("image/gif")
})

it("rejects oversized Codex framing before asset reads or transport", async () => {
  let reads = 0
  let sends = 0
  const client = withSDKResponse({
    responses: {
      async create() {
        sends += 1
        throw new Error("must not send")
      },
    },
  } as unknown as OpenAI)
  const stream = createOpenAIProvider({
    apiKey: "test",
    model: "gpt-6.1-sol",
    requestProfile: "codex",
    client,
  })
  const events = await Array.fromAsync(
    stream({
      target: {
        provider: "personal",
        model: "gpt-6.1-sol",
        instructionProfileId: "codex",
      },
      system: [
        {
          id: "large",
          revision: "1",
          text: "a".repeat(CODEX_IMAGE_REQUEST_SAFETY_BYTES),
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              sizeBytes: 0,
              file: { rolloutId: "history", path: "image.png" },
            },
          ],
        },
      ],
      tools: [],
      toolWireProtocol: "eager",
      assets: {
        async read() {
          reads += 1
          return fixture(1, 1)
        },
      },
    }),
  )
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "failure",
      failure: expect.objectContaining({
        stage: "request_build",
        message: expect.stringContaining("local Codex image request budget"),
      }),
    }),
  )
  expect(reads).toBe(0)
  expect(sends).toBe(0)
})

it("does not fetch externally hosted image URLs on behalf of Codex", async () => {
  let reads = 0
  let sends = 0
  const client = withSDKResponse({
    responses: {
      async create() {
        sends += 1
        throw new Error("must not send")
      },
    },
  } as unknown as OpenAI)
  const stream = createOpenAIProvider({
    apiKey: "test",
    model: "gpt-6.1-sol",
    requestProfile: "codex",
    client,
  })
  const events = await Array.fromAsync(
    stream({
      target: {
        provider: "personal",
        model: "gpt-6.1-sol",
        instructionProfileId: "codex",
      },
      system: [],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              sizeBytes: 0,
              file: { url: "https://example.invalid/private-image.png" },
            },
          ],
        },
      ],
      tools: [],
      toolWireProtocol: "eager",
      assets: {
        async read() {
          reads += 1
          return fixture(1, 1)
        },
      },
    }),
  )
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "failure",
      failure: expect.objectContaining({
        stage: "request_build",
        message: expect.stringContaining("Import the image as an attachment"),
      }),
    }),
  )
  expect(reads).toBe(0)
  expect(sends).toBe(0)
})
