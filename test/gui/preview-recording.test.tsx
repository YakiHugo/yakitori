import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { PreviewRecording } from "../../src/gui/preview-recording.ts"
import type { ComputerPreviewFrame } from "../../src/protocol/computer-preview.ts"

const frame: ComputerPreviewFrame = {
  dataUrl: "data:image/png;base64,first",
  width: 200,
  height: 100,
  frame: { x: 0, y: 0, width: 200, height: 100 },
  receivedAt: "2026-10-31T00:00:00Z",
}
let supportsCodec = true
const track = { stop: vi.fn(), requestFrame: vi.fn() },
  drawing = { fillRect: vi.fn(), drawImage: vi.fn() }
class Encoder {
  static isTypeSupported() {
    return supportsCodec
  }
  state = "inactive"
  ondataavailable?: (event: { data: Blob }) => void
  onerror?: (event: { type: string }) => void
  onstop?: () => void
  start() {
    this.state = "recording"
  }
  stop() {
    this.state = "inactive"
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["encoded bytes"]) })
      this.onstop?.()
    })
  }
}
beforeEach(() => {
  supportsCodec = true
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    drawing as unknown as CanvasRenderingContext2D,
  )
  vi.stubGlobal("MediaRecorder", Encoder)
  Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
    configurable: true,
    value: () => ({ getVideoTracks: () => [track], getTracks: () => [track] }),
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ blob: async () => new Blob(["image"]) })),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream")
})

it("keeps only the latest waiting frame and releases every decoded bitmap", async () => {
  const first = Promise.withResolvers<ImageBitmap>()
  const a = { width: 200, height: 100, close: vi.fn() },
    b = { width: 200, height: 100, close: vi.fn() }
  const decode = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(b)
  vi.stubGlobal("createImageBitmap", decode)
  const recording = new PreviewRecording(frame)
  recording.append(frame)
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
  recording.append({ ...frame, dataUrl: "data:image/png;base64,discarded" })
  recording.append({ ...frame, dataUrl: "data:image/png;base64,latest" })
  first.resolve(a as unknown as ImageBitmap)
  await vi.waitFor(() => expect(track.requestFrame).toHaveBeenCalledTimes(2))
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    frame.dataUrl,
    "data:image/png;base64,latest",
  ])
  expect(a.close).toHaveBeenCalledTimes(1)
  expect(b.close).toHaveBeenCalledTimes(1)
  await recording.stop()
  expect(track.stop).toHaveBeenCalledTimes(1)
})

it("waits for an in-flight decoder on stop without drawing late pixels or leaking its bitmap", async () => {
  const decoding = Promise.withResolvers<ImageBitmap>(),
    bitmap = { width: 200, height: 100, close: vi.fn() }
  const decode = vi.fn(() => decoding.promise)
  vi.stubGlobal("createImageBitmap", decode)
  const recording = new PreviewRecording(frame)
  recording.append(frame)
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
  const stopped = recording.stop()
  recording.append({ ...frame, dataUrl: "data:image/png;base64,late" })
  expect(track.stop).not.toHaveBeenCalled()
  decoding.resolve(bitmap as unknown as ImageBitmap)
  await stopped
  expect(drawing.drawImage).not.toHaveBeenCalled()
  expect(bitmap.close).toHaveBeenCalledTimes(1)
  expect(track.stop).toHaveBeenCalledTimes(1)
  expect(decode).toHaveBeenCalledTimes(1)
})

it("reports a decoding failure while stopping the encoder and its tracks", async () => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      throw new Error("Invalid image")
    }),
  )
  const recording = new PreviewRecording(frame)
  const failed = expect(recording.finished).rejects.toThrow("Invalid image")
  recording.append(frame)
  await failed
  expect(track.stop).toHaveBeenCalledTimes(1)
})

it("releases the capture stream when no supported codec can start", () => {
  supportsCodec = false
  expect(() => new PreviewRecording(frame)).toThrow(
    "WebM recording is unavailable",
  )
  expect(track.stop).toHaveBeenCalledTimes(1)
})
