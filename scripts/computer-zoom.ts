import assert from "node:assert/strict"
import type { McpClient } from "../src/runtime/mcp-client.ts"

type Control = ReturnType<McpClient["bindTool"]>

export async function verifyComputerZoom(context: {
  call: Control
  pid: number
  windowID: number
  state: () => Promise<{ count: number }>
  waitFor: (predicate: () => Promise<boolean>) => Promise<void>
  check: (name: string, execute: () => Promise<void>) => Promise<void>
}) {
  const { call, pid, windowID, state, waitFor, check } = context
  const observe = async () => {
    const result = await call({
      action: "observe",
      pid,
      window_id: windowID,
      mode: "vision",
    })
    assert(!result.isError, JSON.stringify(result.structuredContent))
    return result.structuredContent?.snapshot_id
  }
  await check(
    "zoom captures native pixels with the correct crop orientation",
    async () => {
      const snapshot = await observe()
      const result = await call({
        action: "zoom",
        snapshot_id: snapshot,
        x1: 230,
        y1: 52,
        x2: 310,
        y2: 132,
        max_dimension: 256,
      })
      assert(!result.isError, JSON.stringify(result.structuredContent))
      assert.notEqual(result.structuredContent?.snapshot_id, snapshot)
      assert.equal(result.structuredContent?.image_width, 256)
      assert.equal(result.structuredContent?.image_height, 256)
      const part = result.content.find((part) => part.type === "image")
      assert(part?.type === "image")
      const { createCanvas, loadImage } = await import("@napi-rs/canvas")
      const image = await loadImage(Buffer.from(part.data, "base64"))
      const canvas = createCanvas(256, 256)
      const drawing = canvas.getContext("2d")
      drawing.drawImage(image, 0, 0)
      const at = (x: number, y: number) => {
        const [r, g, b] = drawing.getImageData(x, y, 1, 1).data
        assert(r !== undefined && g !== undefined && b !== undefined)
        return { r, g, b }
      }
      const red = at(64, 64),
        blue = at(192, 64),
        green = at(64, 192),
        yellow = at(192, 192)
      assert(
        red.r > 180 && red.g < 80 && red.b < 80,
        `top-left: ${JSON.stringify(red)}`,
      )
      assert(
        blue.b > 180 && blue.r < 80 && blue.g < 80,
        `top-right: ${JSON.stringify(blue)}`,
      )
      assert(
        green.g > 180 && green.r < 80 && green.b < 80,
        `bottom-left: ${JSON.stringify(green)}`,
      )
      assert(
        yellow.r > 180 && yellow.g > 180 && yellow.b < 80,
        `bottom-right: ${JSON.stringify(yellow)}`,
      )
      const sources = result.structuredContent?.native_captures as {
        window_id: number
        width: number
        height: number
      }[]
      assert.equal(sources.length, 1)
      assert.equal(sources[0]?.window_id, windowID)
      const source = sources[0]
      assert(source)
      assert(source.width >= 420 && source.height >= 332)
    },
  )
  await check(
    "zoom coordinates click the real cropped control and invalidate the old ticket",
    async () => {
      const snapshot = await observe()
      const before = (await state()).count
      const zoomed = await call({
        action: "zoom",
        snapshot_id: snapshot,
        x1: 230,
        y1: 224,
        x2: 370,
        y2: 252,
        max_dimension: 700,
      })
      assert(!zoomed.isError, JSON.stringify(zoomed.structuredContent))
      const stale = await call({
        action: "click",
        snapshot_id: snapshot,
        x: 300,
        y: 238,
      })
      assert.equal(stale.structuredContent?.code, "stale_snapshot")
      assert.equal((await state()).count, before)
      const clicked = await call({
        action: "click",
        snapshot_id: zoomed.structuredContent?.snapshot_id,
        x: 350,
        y: 70,
      })
      assert(!clicked.isError, JSON.stringify(clicked.structuredContent))
      await waitFor(async () => (await state()).count === before + 1)
    },
  )
  await check(
    "zoom refuses a source invalidated by a window mutation",
    async () => {
      const snapshot = await observe()
      const listed = await call({ action: "list" })
      const target = (
        listed.structuredContent?.windows as {
          pid: number
          window_id: number
          launch_time: number
        }[]
      ).find((window) => window.pid === pid && window.window_id === windowID)
      assert(target)
      const moved = await call({
        action: "window",
        window_action: "move",
        pid,
        window_id: windowID,
        launch_time: target.launch_time,
        x: 940,
        y: 520,
      })
      assert(!moved.isError, JSON.stringify(moved.structuredContent))
      const zoomed = await call({
        action: "zoom",
        snapshot_id: snapshot,
        x1: 1,
        y1: 1,
        x2: 10,
        y2: 10,
      })
      assert.equal(zoomed.structuredContent?.code, "stale_snapshot")
    },
  )
}
