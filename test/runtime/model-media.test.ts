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
