import assert from "node:assert/strict"
import type { McpClient } from "../src/runtime/mcp-client.ts"

type Region = {
  region_id: string
  text: string
  confidence: number
  frame: { x: number; y: number; width: number; height: number }
}

export async function verifyComputerRecognition(context: {
  call: ReturnType<McpClient["bindTool"]>
  pid: number
  windowID: number
  state: () => Promise<{ count: number }>
  waitFor: (predicate: () => Promise<boolean>) => Promise<void>
  check: (name: string, execute: () => Promise<void>) => Promise<void>
}) {
  const { call, pid, windowID, state, waitFor, check } = context
  const observe = () =>
    call({
      action: "observe",
      pid,
      window_id: windowID,
      mode: "both",
      recognize_text: true,
    })
  const find = (result: Awaited<ReturnType<typeof call>>) => {
    assert(!result.isError, JSON.stringify(result.structuredContent))
    const regions = result.structuredContent?.text_regions as Region[]
    assert(Array.isArray(regions))
    const region = regions.find((row) => row.text === "OCR action")
    assert(region, JSON.stringify(regions))
    assert(region.confidence > 0.5)
    return region
  }
  await check(
    "OCR reads drawn pixels and clicks a recognized text region",
    async () => {
      const observed = await observe()
      const region = find(observed)
      assert(
        !JSON.stringify(observed.structuredContent?.elements).includes(
          "OCR action",
        ),
        "Drawn text must not come from AX",
      )
      // Fixture's drawn text lies inside this independent screenshot-pixel box.
      assert(region.frame.x >= 20 && region.frame.x + region.frame.width <= 200)
      assert(region.frame.y >= 50 && region.frame.y + region.frame.height <= 90)
      const before = (await state()).count
      const clicked = await call({
        action: "click",
        snapshot_id: observed.structuredContent?.snapshot_id,
        region_id: region.region_id,
      })
      assert(!clicked.isError, JSON.stringify(clicked.structuredContent))
      await waitFor(async () => (await state()).count === before + 1)
    },
  )
  await check(
    "OCR regions are replaced with the screenshot and reject mixed targets",
    async () => {
      const first = await observe()
      const old = find(first)
      const second = await observe()
      const current = find(second)
      assert.notEqual(current.region_id, old.region_id)
      const before = (await state()).count
      const invalid = await call({
        action: "click",
        snapshot_id: second.structuredContent?.snapshot_id,
        region_id: old.region_id,
      })
      assert.equal(invalid.structuredContent?.code, "invalid_region")
      const mixed = await call({
        action: "click",
        snapshot_id: second.structuredContent?.snapshot_id,
        region_id: current.region_id,
        x: 1,
        y: 1,
      })
      assert.equal(mixed.structuredContent?.code, "invalid_arguments")
      assert.equal((await state()).count, before)
    },
  )
  await check(
    "OCR works on a fresh zoom and requires screenshot mode",
    async () => {
      const invalid = await call({
        action: "observe",
        pid,
        window_id: windowID,
        mode: "ax",
        recognize_text: true,
      })
      assert.equal(invalid.structuredContent?.code, "invalid_arguments")
      const observed = await observe()
      const zoomed = await call({
        action: "zoom",
        snapshot_id: observed.structuredContent?.snapshot_id,
        x1: 20,
        y1: 50,
        x2: 200,
        y2: 90,
        max_dimension: 720,
        recognize_text: true,
      })
      const region = find(zoomed)
      assert(region.frame.x >= 0 && region.frame.x + region.frame.width <= 720)
      assert(region.frame.y >= 0 && region.frame.y + region.frame.height <= 160)
      const before = (await state()).count
      const clicked = await call({
        action: "click",
        snapshot_id: zoomed.structuredContent?.snapshot_id,
        region_id: region.region_id,
      })
      assert(!clicked.isError, JSON.stringify(clicked.structuredContent))
      await waitFor(async () => (await state()).count === before + 1)
    },
  )
}
