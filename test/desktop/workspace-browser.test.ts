import { EventEmitter } from "node:events"
import type { BrowserWindow } from "electron"
import { beforeEach, expect, it, vi } from "vitest"
import { registerWorkspaceBrowser } from "../../src/desktop/workspace-browser.ts"
import type {
  BrowserNavigationRequest,
  BrowserObservationRequest,
  BrowserTarget,
} from "../../src/protocol/desktop-browser.ts"
import { parseBrowserNavigationRequest } from "../../src/protocol/desktop-browser.ts"

type IpcEvent = { sender: unknown; senderFrame: unknown }
type Handler = (event: IpcEvent, input: unknown) => unknown
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  views: [] as Array<{
    options: unknown
    webContents: EventEmitter & {
      id: number
      url: string
      getURL(): string
      loadURL(url: string): Promise<void>
      stop: ReturnType<typeof vi.fn>
      reload: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      isFocused: ReturnType<typeof vi.fn>
      capturePage: ReturnType<typeof vi.fn>
    }
    setVisible: ReturnType<typeof vi.fn>
    setBounds: ReturnType<typeof vi.fn>
  }>,
  menu: [] as Array<{ label?: string; click?: () => void }>,
  profile: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  },
}))
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    ipcMain: {
      handle: (name: string, handler: Handler) =>
        electron.handlers.set(name, handler),
      removeHandler: (name: string) => electron.handlers.delete(name),
    },
    clipboard: { writeText: vi.fn() },
    session: { fromPartition: () => electron.profile },
    Menu: {
      buildFromTemplate: (menu: typeof electron.menu) => {
        electron.menu = menu
        return { popup: vi.fn() }
      },
    },
    WebContentsView: class {
      webContents = Object.assign(new EventEmitter(), {
        id: electron.views.length + 1,
        url: "",
        getURL() {
          return this.url
        },
        getTitle: () => "Example",
        getZoomFactor: () => 1,
        isLoading: () => false,
        isLoadingMainFrame: () => false,
        isDestroyed: () => false,
        isFocused: vi.fn(() => false),
        capturePage: vi.fn(async () => ({
          toDataURL: () => "data:image/png;base64,cGFnZQ==",
        })),
        navigationHistory: {
          canGoBack: () => false,
          canGoForward: () => false,
        },
        setWindowOpenHandler: vi.fn(),
        close: vi.fn(),
        stop: vi.fn(),
        reload: vi.fn(),
        async loadURL(url: string) {
          this.url = url
        },
      })
      setVisible = vi.fn()
      setBounds = vi.fn()
      constructor(public options: unknown) {
        electron.views.push(this)
      }
    },
  }
})

beforeEach(() => {
  electron.handlers.clear()
  electron.views.length = 0
  electron.menu.length = 0
})

function setup() {
  const mainFrame = {}
  const sent = vi.fn()
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame,
    send: sent,
    getZoomFactor: () => 1,
    focus: vi.fn(),
  })
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  })
  const controller = registerWorkspaceBrowser(
    window as unknown as BrowserWindow,
  )
  const browser = {
    ...controller,
    request: (input: BrowserObservationRequest | BrowserNavigationRequest) =>
      controller.request(input, {
        sessionId: "session_owned",
        turnId: "turn_owned",
      }),
  }
  const event = { sender: webContents, senderFrame: mainFrame }
  function call(name: string, input: unknown, sender = event) {
    const handler = electron.handlers.get(`yakitori:browser-${name}`)
    if (!handler) throw new Error("Missing browser IPC handler")
    return handler(sender, input)
  }
  return { call, window, sent, event, browser, controller }
}

it("never observes another owned tab or a replacement under the same tab ID", async () => {
  const { call, browser } = setup()
  call("create", { tabId: "first", url: "https://first.test" })
  call("create", { tabId: "second", url: "https://second.test" })
  const listed = await browser.request({ action: "list" })
  expect(listed).toMatchObject({
    tabs: [
      { target: { tabId: "first", webContentsId: 1 } },
      { target: { tabId: "second", webContentsId: 2 } },
    ],
  })
  const target = (listed.tabs as { target: BrowserTarget }[])[0]?.target
  if (!target) throw new Error("Missing first owned target")
  await expect(
    browser.request({
      action: "observe",
      target: { ...target, webContentsId: 2 },
    }),
  ).rejects.toMatchObject({ code: "browser_target_changed" })
  call("close", { tabId: "first" })
  call("create", { tabId: "first", url: "https://replacement.test" })
  // A new desktop process can reuse WebContents IDs. The lifetime nonce must
  // still reject a previously listed target even when both correlated IDs match.
  const replacement = electron.views.at(-1)
  if (!replacement) throw new Error("Missing replacement view")
  replacement.webContents.id = target.webContentsId
  await expect(
    browser.request({
      action: "observe",
      target,
    }),
  ).rejects.toMatchObject({ code: "browser_target_changed" })
})

it("bounds catalog replies without making later browser targets unreachable", async () => {
  const { call, browser } = setup()
  for (let i = 0; i < 40; i++)
    call("create", {
      tabId: `owned_${i}`,
      url: `https://owned.test/${"x".repeat(8192)}`,
    })
  const first = await browser.request({ action: "list" })
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(300 * 1024)
  expect(typeof first.nextOffset).toBe("number")
  if (typeof first.nextOffset !== "number")
    throw new Error("Missing continuation offset")
  const second = await browser.request({
    action: "list",
    offset: first.nextOffset,
  })
  const entries = [
    ...(first.tabs as { target: { tabId: string } }[]),
    ...(second.tabs as { target: { tabId: string } }[]),
  ]
  expect(new Set(entries.map((entry) => entry.target.tabId)).size).toBe(40)
})

it("rejects remote frames and non-web URLs before navigation", () => {
  const { call, event } = setup()
  expect(() =>
    call("create", { tabId: "a" }, { ...event, senderFrame: {} }),
  ).toThrow("untrusted")
  expect(electron.views).toHaveLength(0)
  call("create", { tabId: "a", url: "https://example.com" })
  expect(() =>
    call("navigate", { tabId: "a", url: "file:///etc/passwd" }),
  ).toThrow("HTTP")
  expect(() =>
    call("navigate", { tabId: "a", url: "javascript:alert(1)" }),
  ).toThrow("HTTP")
  expect(electron.views[0]?.webContents.getURL()).toBe("https://example.com/")
})

it("isolates remote pages and keeps their native viewport inside the app", () => {
  const { call } = setup()
  call("create", { tabId: "a" })
  expect(electron.views[0]?.options).toMatchObject({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  expect(electron.views[0]?.options).not.toHaveProperty(
    "webPreferences.preload",
  )
  call("viewport", {
    tabId: "a",
    visible: true,
    x: 900,
    y: 700,
    width: 1000,
    height: 1000,
  })
  expect(electron.views[0]?.setBounds).toHaveBeenLastCalledWith({
    x: 900,
    y: 700,
    width: 100,
    height: 100,
  })
  expect(electron.views[0]?.setVisible).toHaveBeenLastCalledWith(false)
  call("viewport", {
    tabId: "a",
    visible: false,
    x: 900,
    y: 700,
    width: 100,
    height: 100,
  })
  expect(electron.views[0]?.setVisible).toHaveBeenLastCalledWith(false)
})

it("preserves the page behind overlapping controls and ignores a stale capture after layout changes", async () => {
  const { call, window } = setup()
  call("create", { tabId: "a", url: "https://example.com" })
  const view = electron.views[0]
  if (!view) throw new Error("Missing page")
  const viewport = {
    tabId: "a",
    visible: true,
    x: 500,
    y: 50,
    width: 500,
    height: 700,
  }
  await call("viewport", viewport)
  expect(view.setVisible).toHaveBeenLastCalledWith(true)
  expect(await call("viewport", { ...viewport, occluded: true })).toBe(
    "data:image/png;base64,cGFnZQ==",
  )
  expect(view.setVisible).toHaveBeenLastCalledWith(false)
  expect(
    await call("viewport", { ...viewport, width: 450, occluded: true }),
  ).toBe("data:image/png;base64,cGFnZQ==")
  expect(view.webContents.capturePage).toHaveBeenCalledOnce()
  await call("viewport", viewport)
  expect(view.setVisible).toHaveBeenLastCalledWith(true)
  let complete!: (image: { toDataURL(): string }) => void
  view.webContents.capturePage.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve
    }),
  )
  const capture = call("viewport", { ...viewport, occluded: true })
  await call("viewport", viewport)
  complete({ toDataURL: () => "old" })
  expect(await capture).toBeUndefined()
  expect(view.setVisible).toHaveBeenLastCalledWith(true)
  view.webContents.isFocused.mockReturnValue(true)
  await call("viewport", { ...viewport, visible: false })
  expect(window.webContents.focus).toHaveBeenCalledOnce()
})

it("validates initial addresses before creating a page and supports local development addresses", () => {
  const { call } = setup()
  expect(() =>
    call("create", { tabId: "a", url: "https://user:password@example.com" }),
  ).toThrow("passwords")
  expect(electron.views).toHaveLength(0)
  call("create", { tabId: "a", url: "localhost:3000/settings" })
  expect(electron.views[0]?.webContents.getURL()).toBe(
    "http://localhost:3000/settings",
  )
  for (const [url, expected] of [
    ["127.0.0.1:4146", "http://127.0.0.1:4146/"],
    ["[::1]:3000", "http://[::1]:3000/"],
    ["example.com:8443/path", "https://example.com:8443/path"],
    ["https://localhost:3000", "https://localhost:3000/"],
    ["127.example.com", "https://127.example.com/"],
  ]) {
    call("navigate", { tabId: "a", url })
    expect(electron.views[0]?.webContents.getURL()).toBe(expected)
  }
})

it("yields to renderer controls after a capture failure and restores the live page when the popup closes", async () => {
  const { call } = setup()
  call("create", { tabId: "a", url: "https://example.com" })
  const view = electron.views[0]
  if (!view) throw new Error("Missing page")
  const viewport = {
    tabId: "a",
    visible: true,
    x: 500,
    y: 50,
    width: 500,
    height: 700,
  }
  await call("viewport", viewport)
  view.webContents.capturePage.mockRejectedValueOnce(
    new Error("UnknownVizError"),
  )
  await expect(
    call("viewport", { ...viewport, occluded: true }),
  ).rejects.toThrow("UnknownVizError")
  expect(view.setVisible).toHaveBeenLastCalledWith(false)
  await call("viewport", viewport)
  expect(view.setVisible).toHaveBeenLastCalledWith(true)
})

it("ignores late page events and menu actions after a tab closes", () => {
  const { call, sent } = setup()
  call("create", { tabId: "a", url: "https://example.com" })
  const old = electron.views[0]
  if (!old) throw new Error("Missing page")
  old.webContents.emit(
    "context-menu",
    {},
    { selectionText: "Old selection", frameURL: "https://example.com" },
  )
  const click = electron.menu.find(
    (entry) => entry.label === "Add to conversation",
  )?.click
  if (!click) throw new Error("Missing selection menu action")
  click()
  expect(sent).toHaveBeenCalledWith(
    "yakitori:browser-selection",
    expect.objectContaining({ text: "Old selection" }),
  )
  call("close", { tabId: "a" })
  call("create", { tabId: "a", url: "https://new.example.com" })
  sent.mockClear()
  old.webContents.emit("page-title-updated")
  click()
  expect(sent).not.toHaveBeenCalled()
})

it("closes native pages when the trusted renderer reloads", () => {
  const { call, window } = setup()
  call("create", { tabId: "a", url: "https://example.com" })
  window.webContents.emit(
    "did-start-navigation",
    {},
    "http://localhost:5173",
    false,
    true,
  )
  expect(electron.views[0]?.setVisible).toHaveBeenLastCalledWith(false)
  expect(electron.views[0]?.webContents.close).toHaveBeenCalledWith({
    waitForBeforeUnload: false,
  })
  expect(() =>
    call("navigate", { tabId: "a", url: "https://example.com" }),
  ).toThrow("closed")
})

it("forwards only recognized workspace shortcuts from a remote page", () => {
  const { call, sent } = setup()
  call("create", { tabId: "a", url: "https://example.com" })
  const view = electron.views[0]
  if (!view) throw new Error("Missing page")
  const event = { preventDefault: vi.fn() }
  const input = {
    type: "keyDown",
    meta: true,
    control: false,
    shift: false,
    alt: false,
    isComposing: false,
    isAutoRepeat: false,
  }
  for (const [key, modifiers, action] of [
    ["t", {}, "new-browser"],
    ["p", {}, "open-files"],
    ["s", { alt: true }, "new-side-chat"],
    ["b", { shift: true }, "toggle-workspace"],
  ] as const) {
    view.webContents.emit("before-input-event", event, {
      ...input,
      ...modifiers,
      key,
    })
    expect(sent).toHaveBeenLastCalledWith("yakitori:browser-shortcut", action)
  }
  sent.mockClear()
  event.preventDefault.mockClear()
  view.webContents.emit("before-input-event", event, { ...input, key: "x" })
  view.webContents.emit("before-input-event", event, {
    ...input,
    key: "t",
    meta: false,
  })
  expect(sent).not.toHaveBeenCalled()
  expect(event.preventDefault).not.toHaveBeenCalled()
})

it("captures selection provenance before navigation and sends it only on a user menu action", () => {
  const { call, sent } = setup()
  call("create", { tabId: "a", url: "https://example.com" })
  const view = electron.views[0]
  if (!view) throw new Error("Missing native view")
  view.webContents.emit(
    "context-menu",
    {},
    {
      selectionText: "Selected passage",
      frameURL: "https://example.com/frame",
    },
  )
  expect(sent).not.toHaveBeenCalledWith(
    "yakitori:browser-selection",
    expect.anything(),
  )
  view.webContents.url = "https://changed.example/"
  electron.menu.find((entry) => entry.label === "Ask in side chat")?.click?.()
  expect(sent).toHaveBeenCalledWith("yakitori:browser-selection", {
    tabId: "a",
    action: "chat",
    text: "Selected passage",
    url: "https://example.com/frame",
    title: "Example",
  })
})

it("destroys native pages when tabs close and removes IPC when the window closes", () => {
  const { call, window } = setup()
  call("create", { tabId: "a" })
  call("create", { tabId: "b" })
  call("close", { tabId: "a" })
  expect(electron.views[0]?.webContents.close).toHaveBeenCalledWith({
    waitForBeforeUnload: false,
  })
  expect(() =>
    call("navigate", { tabId: "a", url: "https://example.com" }),
  ).toThrow("closed")
  window.emit("closed")
  expect(electron.views[1]?.webContents.close).toHaveBeenCalledWith({
    waitForBeforeUnload: false,
  })
  expect(electron.handlers.size).toBe(0)
})

it("does not publish or cache a capture from a superseded page navigation", async () => {
  const { call } = setup()
  call("create", { tabId: "a", url: "https://first.example" })
  const view = electron.views[0]
  if (!view) throw new Error("Missing page")
  const viewport = {
    tabId: "a",
    visible: true,
    occluded: true,
    x: 500,
    y: 50,
    width: 500,
    height: 700,
  }
  let complete!: (image: { toDataURL(): string }) => void
  view.webContents.capturePage.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve
    }),
  )
  const capture = call("viewport", viewport)
  call("navigate", { tabId: "a", url: "https://second.example" })
  complete({ toDataURL: () => "first-page" })
  expect(await capture).toBeUndefined()
  expect(await call("viewport", viewport)).toBe(
    "data:image/png;base64,cGFnZQ==",
  )
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(2)
})

it("requires an exact browser source URL and the existing HTTP(S) destination policy", () => {
  const valid = {
    action: "navigate",
    target: {
      tabId: "owned",
      webContentsId: 17,
      instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
    },
    fromUrl: "",
    url: "https://destination.test",
  }
  expect(parseBrowserNavigationRequest(valid)).toMatchObject({
    url: "https://destination.test/",
  })
  for (const input of [
    { ...valid, url: "file:///private" },
    { ...valid, url: "javascript:alert(1)" },
    { ...valid, url: "https://name:secret@example.test" },
    { ...valid, url: "destination.test" },
    { ...valid, method: "Page.navigate" },
    { ...valid, fromUrl: 42 },
  ])
    expect(() => parseBrowserNavigationRequest(input)).toThrow()
})

it("navigates a blank owned tab without requiring an attached debugger", async () => {
  const { call, browser } = setup()
  call("create", { tabId: "blank" })
  const listed = await browser.request({ action: "list" })
  const target = (listed.tabs as { target: BrowserTarget }[])[0]?.target
  if (!target) throw new Error("Missing blank target")
  const contents = electron.views[0]?.webContents
  if (!contents) throw new Error("Missing blank contents")
  contents.loadURL = vi.fn(async () => {
    contents.url = "https://redirected.test/"
  })
  await expect(
    browser.request({
      action: "navigate",
      target,
      fromUrl: "wrong",
      url: "https://destination.test/",
    }),
  ).rejects.toMatchObject({ code: "browser_target_changed" })
  expect(contents.loadURL).not.toHaveBeenCalled()
  expect(
    await browser.request({
      action: "navigate",
      target,
      fromUrl: "",
      url: "https://destination.test/",
    }),
  ).toMatchObject({ target, url: "https://redirected.test/", loaded: true })
  expect(contents.loadURL).toHaveBeenCalledTimes(1)
})

it("cancels only its own load and waits for Electron to acknowledge cancellation", async () => {
  const { call, browser, controller } = setup()
  call("create", { tabId: "blank" })
  const listed = await browser.request({ action: "list" }),
    target = (listed.tabs as { target: BrowserTarget }[])[0]?.target
  const contents = electron.views[0]?.webContents
  if (!target || !contents) throw new Error("Missing blank target")
  const started = Promise.withResolvers<void>(),
    load = Promise.withResolvers<void>(),
    cancellation = new AbortController()
  contents.loadURL = vi.fn(async (url) => {
    contents.url = url
    started.resolve()
    await load.promise
  })
  let completed = false
  const pending = controller
    .request(
      {
        action: "navigate",
        target,
        fromUrl: "",
        url: "https://destination.test/",
      },
      { sessionId: "session_owned", turnId: "turn_owned" },
      cancellation.signal,
    )
    .finally(() => {
      completed = true
    })
  await started.promise
  await expect(
    browser.request({
      action: "navigate",
      target,
      fromUrl: "https://destination.test/",
      url: "https://duplicate.test/",
    }),
  ).rejects.toMatchObject({ code: "browser_busy" })
  cancellation.abort()
  expect(contents.stop).toHaveBeenCalledTimes(1)
  expect(completed).toBe(false)
  load.reject(Object.assign(new Error("ERR_ABORTED"), { errno: -3 }))
  await expect(pending).rejects.toMatchObject({
    code: "browser_navigation_unconfirmed",
  })
  expect(contents.loadURL).toHaveBeenCalledTimes(1)
})

it.each([
  "navigate",
  "reload",
])("does not stop a user navigation that superseded an agent load (action=%s)", async (action) => {
  const { call, browser, controller } = setup()
  call("create", { tabId: "blank" })
  const listed = await browser.request({ action: "list" }),
    target = (listed.tabs as { target: BrowserTarget }[])[0]?.target
  const contents = electron.views[0]?.webContents
  if (!target || !contents) throw new Error("Missing blank target")
  const started = Promise.withResolvers<void>(),
    load = Promise.withResolvers<void>(),
    cancellation = new AbortController()
  contents.loadURL = vi.fn(async (url) => {
    contents.url = url
    if (url === "https://destination.test/") {
      started.resolve()
      await load.promise
    }
  })
  const pending = controller.request(
    {
      action: "navigate",
      target,
      fromUrl: "",
      url: "https://destination.test/",
    },
    { sessionId: "session_owned", turnId: "turn_owned" },
    cancellation.signal,
  )
  await started.promise
  if (action === "navigate")
    call("navigate", { tabId: "blank", url: "https://user.test/" })
  else call("action", { tabId: "blank", action: "reload" })
  cancellation.abort()
  expect(contents.stop).not.toHaveBeenCalled()
  load.reject(Object.assign(new Error("ERR_ABORTED"), { errno: -3 }))
  await expect(pending).rejects.toMatchObject({
    code: "browser_navigation_unconfirmed",
  })
  expect(contents.getURL()).toBe(
    action === "navigate" ? "https://user.test/" : "https://destination.test/",
  )
  expect(contents.loadURL).toHaveBeenCalledTimes(action === "navigate" ? 2 : 1)
})

it("retains logical page geometry when an unmounted browser panel sends an empty hidden viewport", async () => {
  const { call } = setup()
  call("create", { tabId: "background", url: "https://example.test" })
  const view = electron.views[0]
  if (!view) throw new Error("Missing background view")
  expect(view.setBounds).toHaveBeenLastCalledWith({
    x: 0,
    y: 0,
    width: 1000,
    height: 800,
  })
  await call("viewport", {
    tabId: "background",
    visible: true,
    x: 500,
    y: 50,
    width: 450,
    height: 700,
  })
  await call("viewport", {
    tabId: "background",
    visible: false,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  })
  expect(view.setBounds).toHaveBeenLastCalledWith({
    x: 500,
    y: 50,
    width: 450,
    height: 700,
  })
  expect(view.setVisible).toHaveBeenLastCalledWith(false)
})

it("keeps page context menus out of the host while a turn owns the browser and restores user menus after cleanup", async () => {
  const { call, browser, controller } = setup()
  call("create", { tabId: "owned", url: "https://owned.test/" })
  const view = electron.views[0]
  if (!view) throw new Error("Missing owned view")
  const events = new EventEmitter()
  let attached = false
  Object.assign(view.webContents, {
    isDevToolsOpened: () => false,
    debugger: {
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
      async sendCommand(method: string) {
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: {
                id: "main",
                loaderId: "owned",
                url: "https://owned.test/",
              },
            },
          }
        if (method === "Accessibility.getFullAXTree") return { nodes: [] }
        throw new Error(`Unexpected command ${method}`)
      },
    },
  })
  const listed = await browser.request({ action: "list" })
  const target = (listed.tabs as { target: BrowserTarget }[])[0]?.target
  if (!target) throw new Error("Missing owned target")
  await browser.request({ action: "observe", target })
  view.webContents.emit("context-menu", {}, { selectionText: "" })
  expect(electron.menu).toEqual([])
  await controller.finishTurn({
    sessionId: "session_owned",
    turnId: "turn_owned",
  })
  view.webContents.emit("context-menu", {}, { selectionText: "" })
  expect(electron.menu).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: "Back" })]),
  )
})
