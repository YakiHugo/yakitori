import { expect, it } from "vitest"
import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import type { ModelMessage } from "../../src/runtime/model.ts"
import { pngImageBase64 } from "../fixtures/images.ts"

it("identifies the earlier corrupt inline image without mutating history or the current message", async () => {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Earlier image" },
        {
          type: "image",
          mediaType: "image/png",
          data: Buffer.from(pngImageBase64, "base64")
            .subarray(0, 24)
            .toString("base64"),
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "Current message" }] },
  ]
  const original = JSON.stringify(messages)
  await expect(
    prepareModelMedia(messages, {
      target: {
        provider: "test",
        model: "vision",
        instructionProfileId: "default",
      },
      imageCapabilities: {
        inputModalities: ["text", "image"],
        imageDetailModes: ["high"],
      },
      rolloutAssets: undefined,
      documentReading: { nativePdf: false, images: true },
      userDocumentReading: { nativePdf: false, images: true },
    }),
  ).rejects.toThrow("Image in user message 1, part 2: Image was not sent")
  expect(JSON.stringify(messages)).toBe(original)
})

it.each([
  [true, "claude-sonnet-4-6", 2400],
  [false, "claude-sonnet-4-6", 2400],
  [true, "claude-future", 2400],
] as const)("preserves source resolution before a model-specific adapter regardless of deferred preparation (%s, %s)", async (deferImagePreparation, model, width) => {
  const { default: sharp } = await import("sharp")
  const bytes = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer()
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          mediaType: "image/jpeg",
          data: bytes.toString("base64"),
          detail: "high",
        },
      ],
    },
  ]
  const original = JSON.stringify(messages)
  const projected = await prepareModelMedia(messages, {
    deferImagePreparation,
    target: {
      provider: "custom-label",
      model,
      instructionProfileId: "default",
    },
    imageCapabilities: {
      inputModalities: ["text", "image"],
      imageDetailModes: ["high"],
    },
    rolloutAssets: undefined,
    documentReading: { nativePdf: false, images: true },
    userDocumentReading: { nativePdf: false, images: true },
  })
  const message = projected[0]
  if (message?.role !== "user") throw new Error("Missing user message")
  const image = message.content[0]
  if (image?.type !== "image" || image.data === undefined)
    throw new Error("Missing image")
  expect(
    (await sharp(Buffer.from(image.data, "base64")).metadata()).width,
  ).toBe(width)
  if (width === 2400) expect(image.data).toBe(bytes.toString("base64"))
  expect(JSON.stringify(messages)).toBe(original)
})
