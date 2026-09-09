import { expect, it } from "vitest"
import sharp from "sharp"
import { prepareModelImage } from "../../src/runtime/prepare-model-image.ts"
import { inspectImageBytes } from "../../src/kernel/image-metadata.ts"

it("fits high detail to 2048 pixels without cropping and preserves original detail", async () => {
  const bytes = await sharp({
    create: { width: 4096, height: 1024, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  const high = await prepareModelImage(bytes, "high")
  if (high.data === undefined) throw new Error("Missing prepared image")
  expect(inspectImageBytes(Buffer.from(high.data, "base64"))).toMatchObject({
    width: 2048,
    height: 512,
  })
  const original = await prepareModelImage(bytes, "original")
  expect(original.data).toBe(bytes.toString("base64"))
})
