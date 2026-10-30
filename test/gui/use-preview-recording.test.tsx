import { act, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { usePreviewRecording } from "../../src/gui/use-preview-recording.ts"
import type { ComputerPreviewFrame } from "../../src/protocol/computer-preview.ts"

const encoders = vi.hoisted(
  () =>
    [] as {
      completion: ReturnType<
        typeof Promise.withResolvers<{ blob: Blob; reason: "stopped" | "size" }>
      >
      append: ReturnType<typeof vi.fn<(frame: ComputerPreviewFrame) => void>>
      stop: ReturnType<
        typeof vi.fn<() => Promise<{ blob: Blob; reason: "stopped" | "size" }>>
      >
    }[],
)
vi.mock("../../src/gui/preview-recording.ts", () => ({
  PreviewRecording: class {
    completion = Promise.withResolvers<{
      blob: Blob
      reason: "stopped" | "size"
    }>()
    finished = this.completion.promise
    append = vi.fn<(frame: ComputerPreviewFrame) => void>()
    stop = vi.fn(() => this.finished)
    constructor() {
      encoders.push(this)
    }
  },
}))
const frame: ComputerPreviewFrame = {
  dataUrl: "data:image/png;base64,owned",
  width: 200,
  height: 100,
  frame: { x: 0, y: 0, width: 200, height: 100 },
  receivedAt: "2026-10-31T00:00:00Z",
}
afterEach(() => {
  encoders.length = 0
  vi.restoreAllMocks()
})

it.each([
  "target",
  "hidden",
])("stops the original encoder before a %s transition can append another target's frame", async (transition) => {
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:owned"),
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const hook = renderHook(
    ({ active, identity, frame }) =>
      usePreviewRecording(frame, active, identity),
    {
      initialProps: { active: true, identity: "owned", frame },
    },
  )
  act(() => hook.result.current.start())
  const encoder = encoders[0]
  if (!encoder) throw new Error("No recording owner")
  expect(encoder.append.mock.calls).toEqual([[frame]])
  const other = { ...frame, dataUrl: "data:image/png;base64,other" }
  hook.rerender({
    active: transition !== "hidden",
    identity: "other",
    frame: other,
  })
  expect(encoder.stop).toHaveBeenCalledTimes(1)
  expect(encoder.append.mock.calls).toEqual([[frame]])
  act(() => hook.result.current.start())
  expect(encoders).toHaveLength(1)
  await act(async () => {
    encoder.completion.resolve({
      blob: new Blob(["owned clip"]),
      reason: "stopped",
    })
    await encoder.completion.promise
  })
  expect(hook.result.current.recording).toBe(false)
  expect(hook.result.current.clip?.url).toBe("blob:owned")
  expect(create).toHaveBeenCalledTimes(1)
  hook.unmount()
  expect(revoke).toHaveBeenCalledWith("blob:owned")
})

it("finishes encoder ownership on unmount without allocating a late object URL", async () => {
  const create = vi.spyOn(URL, "createObjectURL")
  const hook = renderHook(() => usePreviewRecording(frame, true, "owned"))
  act(() => hook.result.current.start())
  const encoder = encoders[0]
  if (!encoder) throw new Error("No recording owner")
  hook.unmount()
  expect(encoder.stop).toHaveBeenCalledTimes(1)
  await act(async () => {
    encoder.completion.resolve({
      blob: new Blob(["late clip"]),
      reason: "stopped",
    })
    await encoder.completion.promise
  })
  expect(create).not.toHaveBeenCalled()
})

it("surfaces an encoder failure and allows a new explicit recording", async () => {
  const hook = renderHook(() => usePreviewRecording(frame, true, "owned"))
  act(() => hook.result.current.start())
  const encoder = encoders[0]
  if (!encoder) throw new Error("No recording owner")
  await act(async () => {
    encoder.completion.reject(new Error("Decoder failed"))
    await encoder.completion.promise.catch(() => {})
  })
  expect(hook.result.current.recording).toBe(false)
  expect(hook.result.current.error).toBe("Decoder failed")
  expect(hook.result.current.clip).toBeUndefined()
  act(() => hook.result.current.start())
  expect(encoders).toHaveLength(2)
  expect(hook.result.current.error).toBeUndefined()
  hook.unmount()
  encoders[1]?.completion.resolve({
    blob: new Blob(["cleanup"]),
    reason: "stopped",
  })
})
