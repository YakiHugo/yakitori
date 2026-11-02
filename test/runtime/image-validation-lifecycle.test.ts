import { beforeEach, expect, it, vi } from "vitest"
import { pngImageBase64, secondPngImageBase64 } from "../fixtures/images.ts"

const decoder = vi.hoisted(() => ({ stats: vi.fn() }))
vi.mock("sharp", () => ({ default: () => ({ stats: decoder.stats }) }))

beforeEach(() => {
  vi.resetModules()
  decoder.stats.mockReset()
})

it("cancels queued validation promptly without releasing an active decoder early", async () => {
  const { validateModelImage } = await import(
    "../../src/runtime/prepare-model-image.ts"
  )
  const active = Promise.withResolvers<void>()
  decoder.stats.mockReturnValueOnce(active.promise).mockResolvedValue(undefined)
  const first = validateModelImage(Buffer.from(pngImageBase64, "base64"))
  await vi.waitFor(() => expect(decoder.stats).toHaveBeenCalledTimes(1))
  const controller = new AbortController()
  const second = validateModelImage(
    Buffer.from(secondPngImageBase64, "base64"),
    controller.signal,
  )
  const cancelled = expect(second).rejects.toThrow("stop waiting")
  controller.abort(new Error("stop waiting"))
  await cancelled
  const third = validateModelImage(
    Buffer.concat([
      Buffer.from(pngImageBase64, "base64"),
      Buffer.from("third"),
    ]),
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(decoder.stats).toHaveBeenCalledTimes(1)
  active.resolve()
  await Promise.all([first, third])
  expect(decoder.stats).toHaveBeenCalledTimes(2)
})

it("does not cache failed decoding and keys successful validation by all image bytes", async () => {
  const { validateModelImage } = await import(
    "../../src/runtime/prepare-model-image.ts"
  )
  const bytes = Buffer.from(pngImageBase64, "base64")
  decoder.stats
    .mockRejectedValueOnce(new Error("corrupt pixels"))
    .mockResolvedValue(undefined)
  await expect(validateModelImage(bytes)).rejects.toThrow("corrupt pixels")
  await validateModelImage(bytes)
  await validateModelImage(Buffer.from(bytes))
  await validateModelImage(
    Buffer.concat([bytes, Buffer.from("different bytes")]),
  )
  expect(decoder.stats).toHaveBeenCalledTimes(3)
})

it("returns active cancellation promptly without caching unfinished validation or overlapping decoders", async () => {
  const { validateModelImage } = await import(
    "../../src/runtime/prepare-model-image.ts"
  )
  const active = Promise.withResolvers<void>()
  decoder.stats.mockReturnValueOnce(active.promise).mockResolvedValue(undefined)
  const bytes = Buffer.from(pngImageBase64, "base64")
  const controller = new AbortController()
  const first = validateModelImage(bytes, controller.signal)
  const cancelled = expect(first).rejects.toThrow("cancel active")
  await vi.waitFor(() => expect(decoder.stats).toHaveBeenCalledTimes(1))
  controller.abort(new Error("cancel active"))
  await cancelled
  const retry = validateModelImage(bytes)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(decoder.stats).toHaveBeenCalledTimes(1)
  active.resolve()
  await retry
  expect(decoder.stats).toHaveBeenCalledTimes(2)
})
