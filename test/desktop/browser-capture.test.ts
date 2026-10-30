import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WebContents } from "electron"
import sharp from "sharp"
import { expect, it } from "vitest"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { captureBrowserPage } from "../../src/desktop/browser-capture.ts"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"
import { inspectImageBytes } from "../../src/kernel/image-metadata.ts"
import {
  type BrowserCaptureRequest,
  parseBrowserCaptureRequest,
} from "../../src/protocol/desktop-browser.ts"
import { isJsonObject } from "../../src/protocol/json.ts"
import { createBrowserCaptureTool } from "../../src/server/browser-capture-tool.ts"

const target = {
  tabId: "owned",
  webContentsId: 17,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const input: BrowserCaptureRequest = {
  action: "capture",
  target,
  mode: "viewport",
}
const sample = () =>
  sharp({
    create: { width: 64, height: 64, channels: 3, background: "#12a05b" },
  })
    .jpeg()
    .toBuffer()

function commands(
  bytes: Buffer,
  options: {
    pageHeight?: number
    block?: Promise<void>
    navigate?: boolean
    zoomAfterCapture?: number
  } = {},
) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const events = new EventEmitter(),
    started = Promise.withResolvers<void>()
  let attached = false,
    documentId = "original",
    zoom = 1
  const debug = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    isAttached: () => attached,
    attach: () => {
      attached = true
    },
    detach: () => {
      attached = false
      events.emit("detach")
    },
    async sendCommand(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: {
              id: "main",
              loaderId: documentId,
              url: "https://owned.test/",
            },
          },
        }
      if (method === "Page.getLayoutMetrics")
        return {
          cssContentSize: {
            x: 0,
            y: 0,
            width: 800,
            height: options.pageHeight ?? 1800,
          },
          cssVisualViewport: {
            pageX: 0,
            pageY: 100,
            clientWidth: 800,
            clientHeight: 600,
          },
        }
      if (method === "Page.captureScreenshot") {
        started.resolve()
        await options.block
        if (options.navigate) documentId = "replacement"
        if (options.zoomAfterCapture) zoom = options.zoomAfterCapture
        return { data: bytes.toString("base64") }
      }
      throw new Error(`Unexpected command ${method}`)
    },
  }
  const contents = {
    debugger: debug,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getZoomFactor: () => zoom,
    isDevToolsOpened: () => false,
    getURL: () => "https://owned.test/",
  }
  return {
    command: debug.sendCommand,
    calls,
    started: started.promise,
    attached: () => attached,
    contents: contents as unknown as WebContents,
  }
}

it("requires exact capture targets and rejects cross-mode or oversized clip arguments", () => {
  expect(parseBrowserCaptureRequest(input)).toEqual(input)
  expect(
    parseBrowserCaptureRequest({
      ...input,
      mode: "clip",
      clip: { x: 5, y: 10, width: 80, height: 60 },
    }),
  ).toMatchObject({ mode: "clip" })
  for (const request of [
    { ...input, clip: { x: 0, y: 0, width: 10, height: 10 } },
    { ...input, mode: "clip", clip: { x: -1, y: 0, width: 10, height: 10 } },
    { ...input, mode: "clip", clip: { x: 0, y: 0, width: 5000, height: 5000 } },
    { ...input, mode: "clip", clip: { x: 0, y: 0, width: 0, height: 10 } },
    { ...input, method: "Page.captureScreenshot" },
    { ...input, target: { ...target, instanceId: "old" } },
  ])
    expect(() => parseBrowserCaptureRequest(request)).toThrow()
})

it("captures the scrolled viewport, full document or explicit clip without changing page scroll", async () => {
  for (const [request, expected] of [
    [input, { x: 0, y: 100, width: 800, height: 600, scale: 1 }],
    [
      { ...input, mode: "page" },
      { x: 0, y: 0, width: 800, height: 1800, scale: 0.8888888888888888 },
    ],
    [
      {
        ...input,
        mode: "clip",
        clip: { x: 20, y: 50, width: 100, height: 80 },
      },
      { x: 20, y: 50, width: 100, height: 80, scale: 1 },
    ],
  ] as const) {
    const f = commands(await sample())
    const result = await captureBrowserPage(request, f.command, 1)
    expect(result.capture).toMatchObject({
      mode: request.mode,
      width: 64,
      height: 64,
    })
    expect(f.calls).toEqual([
      { method: "Page.getLayoutMetrics", params: {} },
      {
        method: "Page.captureScreenshot",
        params: {
          format: "jpeg",
          quality: 80,
          fromSurface: true,
          captureBeyondViewport: true,
          clip: expected,
        },
      },
    ])
  }
})

it("bounds encoded output dimensions and retains the captured pixels", async () => {
  const source = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: "#12a05b" },
  })
    .jpeg()
    .toBuffer()
  const f = commands(source),
    result = await captureBrowserPage(input, f.command, 1)
  if (typeof result.imageBase64 !== "string")
    throw new Error("Missing encoded image")
  const bytes = Buffer.from(result.imageBase64, "base64")
  expect(inspectImageBytes(bytes)).toEqual({
    mediaType: "image/jpeg",
    width: 1600,
    height: 800,
  })
  const pixel = await sharp(bytes)
    .extract({ left: 20, top: 20, width: 1, height: 1 })
    .raw()
    .toBuffer()
  expect(Math.abs((pixel[0] ?? 0) - 18)).toBeLessThan(5)
  expect(Math.abs((pixel[1] ?? 0) - 160)).toBeLessThan(5)
  expect(Math.abs((pixel[2] ?? 0) - 91)).toBeLessThan(5)
})

it("refuses oversized full-page paint but permits a bounded clip on that same document", async () => {
  const f = commands(await sample(), { pageHeight: 100000 })
  await expect(
    captureBrowserPage({ ...input, mode: "page" }, f.command, 1),
  ).rejects.toMatchObject({ code: "browser_capture_size" })
  expect(f.calls.some((call) => call.method === "Page.captureScreenshot")).toBe(
    false,
  )
  await expect(
    captureBrowserPage(
      {
        ...input,
        mode: "clip",
        clip: { x: 0, y: 50000, width: 100, height: 100 },
      },
      f.command,
      1,
    ),
  ).resolves.toHaveProperty("imageBase64")
})

it.each([
  "document",
  "zoom",
])("discards a capture when its %s changes before receipt", async (changed) => {
  const f = commands(
      await sample(),
      changed === "document" ? { navigate: true } : { zoomAfterCapture: 1.5 },
    ),
    connection = new BrowserDocumentConnection(f.contents)
  try {
    await expect(
      connection.capture(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_target_changed" })
  } finally {
    await connection.close()
  }
})

it("cancels a pending read by closing its owned debugger instead of returning a late image", async () => {
  const release = Promise.withResolvers<void>(),
    cancellation = new AbortController()
  const f = commands(await sample(), { block: release.promise }),
    connection = new BrowserDocumentConnection(f.contents)
  try {
    const pending = connection.capture(input, cancellation.signal)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "browser_cancelled",
    })
    await f.started
    cancellation.abort()
    await rejected
    expect(f.attached()).toBe(false)
  } finally {
    release.resolve()
    await connection.close()
  }
})

it("stores browser pixels as a conversation asset and projects an image without exposing base64 in tool text", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-browser-capture-"))
  const bytes = await sample(),
    assets = createRolloutAssets(root, {
      withMutationLease: (_id, mutate) => mutate(),
    })
  const tool = createBrowserCaptureTool(
    {
      request: async () => ({
        imageBase64: bytes.toString("base64"),
        capture: { mode: "viewport" },
        target,
      }),
      finishTurn: async () => {},
      closeSession: async () => {},
    },
    async () => undefined,
  )
  try {
    await mkdir(join(root, "rollouts", "rollout_owned"), { recursive: true })
    const result = await tool.execute(input, {
      workspaceRoot: root,
      threadId: "session_owned",
      turnId: "turn_owned",
      rolloutId: "rollout_owned",
      toolCallId: "call_capture",
      rolloutAssets: assets,
      documentReading: { nativePdf: false, images: true },
    })
    expect(result.ok).toBe(true)
    if (
      !isJsonObject(result.output) ||
      !isJsonObject(result.output.file) ||
      typeof result.output.file.rolloutId !== "string" ||
      typeof result.output.file.path !== "string"
    )
      throw new Error("Missing saved image reference")
    expect(
      await assets.read({
        rolloutId: result.output.file.rolloutId,
        path: result.output.file.path,
      }),
    ).toEqual(bytes)
    expect(result.content).not.toContain(bytes.toString("base64"))
    expect(
      await result.presentation?.toModelContent({
        maxBytes: 4096,
        maxLines: 100,
      }),
    ).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          mediaType: "image/jpeg",
          file: result.output.file,
        }),
      ]),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("refuses screenshot dispatch for a text-only model", async () => {
  let dispatched = false
  const tool = createBrowserCaptureTool(
    {
      request: async () => {
        dispatched = true
        return {}
      },
      finishTurn: async () => {},
      closeSession: async () => {},
    },
    async () => undefined,
  )
  expect(
    await tool.execute(input, {
      workspaceRoot: "/unused",
      documentReading: { nativePdf: false, images: false },
    }),
  ).toMatchObject({ ok: false, code: "unsupported_model" })
  expect(dispatched).toBe(false)
})
