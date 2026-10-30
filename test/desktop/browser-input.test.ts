import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"
import {
  type BrowserKeyRequest,
  type BrowserPointerRequest,
  type BrowserTextInputRequest,
  parseBrowserInputRequest,
} from "../../src/protocol/desktop-browser.ts"

const target = {
  tabId: "owned",
  webContentsId: 17,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const ownerReference = "browser_node_00000000-0000-4000-8000-000000000001"

it("accepts bounded text input only with an exact observation reference", () => {
  const valid = {
    action: "type",
    target,
    reference: ownerReference,
    text: "你好 🌍",
  }
  expect(parseBrowserInputRequest(valid)).toEqual(valid)
  expect(
    parseBrowserInputRequest({ ...valid, action: "fill", text: "" }),
  ).toMatchObject({ action: "fill", text: "" })
  for (const input of [
    { ...valid, reference: "button" },
    { ...valid, method: "Input.insertText" },
    { ...valid, text: "" },
    { ...valid, text: "🌍".repeat(17000) },
    { ...valid, target: { ...target, webContentsId: 0 } },
    { ...valid, action: "evaluate" },
  ])
    expect(() => parseBrowserInputRequest(input)).toThrow()
})

function fixture(
  options: {
    redirectFocus?: boolean
    blockInput?: boolean
    wrongReceipt?: boolean
    blockKeyDown?: boolean
    failKeyUp?: boolean
    failKeyUpKey?: string
    loseDebuggerOnKeyDown?: boolean
    keys?: boolean
    blockKeyDownAt?: number
    pointer?: boolean
    covered?: boolean
    coverAfterHover?: boolean
    blockPress?: boolean
    failMouseUp?: boolean
    navigateAfterRelease?: boolean
    blockFocusReadAt?: number
    blockKeyUp?: boolean
  } = {},
) {
  const events = new EventEmitter(),
    insertion = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    focusReadStarted = Promise.withResolvers<void>(),
    focusReadReply = Promise.withResolvers<void>(),
    keyUpStarted = Promise.withResolvers<void>(),
    keyUpReply = Promise.withResolvers<void>()
  const mouseEvents: Record<string, unknown>[] = []
  const keyEvents: Record<string, unknown>[] = []
  let destroyed = false,
    keyDowns = 0,
    keyUps = 0,
    presses = 0,
    releases = 0,
    moves = 0,
    focusReads = 0
  let attached = false,
    documentId = "original",
    value = "first",
    inputCalls = 0,
    focused = false,
    start = 5,
    end = 5
  const contents = {
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => false,
    getURL: () => "https://owned.test/",
    debugger: {
      on: events.on.bind(events),
      off: events.off.bind(events),
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
        events.emit("detach", {}, "closed")
      },
      async sendCommand(method: string, params: Record<string, unknown>) {
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
        if (method === "Accessibility.getFullAXTree")
          return {
            nodes: [
              {
                nodeId: "field",
                backendDOMNodeId: 31,
                role: { value: options.pointer ? "button" : "textbox" },
                name: { value: "Owned field" },
              },
            ],
          }
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: 71 }
        if (method === "DOM.resolveNode")
          return { object: { objectId: "exact-control" } }
        if (method === "DOM.focus") {
          focused = true
          return {}
        }
        if (method === "Runtime.callFunctionOn") {
          if (options.keys) {
            if (++focusReads === options.blockFocusReadAt) {
              focusReadStarted.resolve()
              await focusReadReply.promise
            }
            return { result: { value: focused && !options.redirectFocus } }
          }
          if (options.pointer)
            return { result: { value: { ok: !options.covered, x: 20, y: 30 } } }
          const args = params.arguments as { value: boolean }[]
          if (args[1]?.value) {
            start = 0
            end = value.length
          }
          return {
            result: {
              value: {
                ok: focused && !options.redirectFocus,
                value,
                start,
                end,
              },
            },
          }
        }
        if (method === "Input.dispatchMouseEvent") {
          mouseEvents.push(params)
          if (params.type === "mouseMoved") {
            moves++
            if (options.coverAfterHover) options.covered = true
          } else if (params.type === "mousePressed") {
            presses++
            insertion.resolve()
            if (options.blockPress) await release.promise
          } else if (params.type === "mouseReleased") {
            if (options.failMouseUp)
              throw new Error("Mouse-up acknowledgement lost")
            releases++
            if (options.navigateAfterRelease) documentId = "replacement"
          }
          return {}
        }
        if (method === "Input.dispatchKeyEvent") {
          keyEvents.push(params)
          if (params.type === "rawKeyDown" || params.type === "keyDown") {
            keyDowns++
            if (params.key === "Backspace") {
              value = value.slice(0, start) + value.slice(end)
              end = start
            }
            insertion.resolve()
            if (options.loseDebuggerOnKeyDown) {
              events.emit("detach", {}, "replaced_with_devtools")
              attached = true
            }
            if (
              options.blockKeyDown &&
              keyDowns === (options.blockKeyDownAt ?? 1)
            )
              await release.promise
          } else {
            keyUpStarted.resolve()
            if (options.blockKeyUp) await keyUpReply.promise
            if (options.failKeyUp || options.failKeyUpKey === params.key)
              throw new Error("Key-up acknowledgement lost")
            keyUps++
          }
          return {}
        }
        if (method === "Input.insertText") {
          inputCalls++
          insertion.resolve()
          if (options.blockInput) await release.promise
          if (!options.wrongReceipt) {
            const text = String(params.text)
            value = value.slice(0, start) + text + value.slice(end)
            start += text.length
            end = start
          }
          return {}
        }
        if (method === "Runtime.releaseObjectGroup") return {}
        throw new Error(`Unexpected CDP command: ${method}`)
      },
    },
  }
  const connection = new BrowserDocumentConnection(
    contents as unknown as WebContents,
  )
  return {
    connection,
    insertion: insertion.promise,
    release,
    focusReadStarted,
    focusReadReply,
    keyUpStarted,
    keyUpReply,
    inputCalls: () => inputCalls,
    value: () => value,
    keyDowns: () => keyDowns,
    keyUps: () => keyUps,
    presses: () => presses,
    releases: () => releases,
    moves: () => moves,
    mouseEvents,
    keyEvents,
    allowMouseUp: () => {
      options.failMouseUp = false
    },
    attached: () => attached,
    allowKeyUp: () => {
      options.failKeyUp = false
      delete options.failKeyUpKey
    },
    destroy: () => {
      destroyed = true
    },
    navigate: () => {
      documentId = "replacement"
    },
    async clickRequest(): Promise<BrowserPointerRequest> {
      const observed = await connection.observe(new AbortController().signal)
      const reference = (observed.nodes as { elementReference: string }[])[0]
        ?.elementReference
      if (!reference) throw new Error("Missing pointer reference")
      return { action: "click", target, reference }
    },
    async request(text = "你好 🌍"): Promise<BrowserTextInputRequest> {
      const observed = await connection.observe(new AbortController().signal)
      const reference = (observed.nodes as { inputReference: string }[])[0]
        ?.inputReference
      if (!reference) throw new Error("Missing observed input reference")
      return { action: "type", target, reference, text }
    },
  }
}

it("consumes an observation once and verifies the exact text receipt", async () => {
  const f = fixture()
  try {
    const input = await f.request()
    expect(
      await f.connection.inputText(input, new AbortController().signal),
    ).toMatchObject({ delivered: true, textVerified: true })
    expect(f.value()).toBe("first你好 🌍")
    await expect(
      f.connection.inputText(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_reference_stale" })
    expect(f.inputCalls()).toBe(1)
  } finally {
    await f.connection.close()
  }
})

it("invalidates older references when a new observation is requested", async () => {
  const f = fixture()
  try {
    const old = await f.request()
    await f.request()
    await expect(
      f.connection.inputText(old, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_reference_stale" })
    expect(f.inputCalls()).toBe(0)
  } finally {
    await f.connection.close()
  }
})

it("refuses replacement documents and redirected focus before inserting any text", async () => {
  for (const redirected of [false, true]) {
    const f = fixture({ redirectFocus: redirected })
    try {
      const input = await f.request()
      if (!redirected) f.navigate()
      await expect(
        f.connection.inputText(input, new AbortController().signal),
      ).rejects.toMatchObject({
        code: redirected
          ? "browser_input_unavailable"
          : "browser_target_changed",
      })
      expect(f.inputCalls()).toBe(0)
    } finally {
      await f.connection.close()
    }
  }
})

it("reports an unconfirmed receipt without repeating a text insertion", async () => {
  const f = fixture({ wrongReceipt: true })
  try {
    const input = await f.request()
    await expect(
      f.connection.inputText(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_input_unconfirmed" })
    expect(f.inputCalls()).toBe(1)
  } finally {
    await f.connection.close()
  }
})

it("does not abandon an in-flight text dispatch when cancellation arrives", async () => {
  const f = fixture({ blockInput: true }),
    cancellation = new AbortController()
  try {
    const input = await f.request()
    let settled = false
    const pending = f.connection
      .inputText(input, cancellation.signal)
      .finally(() => {
        settled = true
      })
    await f.insertion
    cancellation.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    f.release.resolve()
    await expect(pending).rejects.toThrow()
    expect(f.inputCalls()).toBe(1)
  } finally {
    f.release.resolve()
    await f.connection.close()
  }
})

it("fills and clears the exact control with acknowledged key release", async () => {
  const f = fixture()
  try {
    const first = await f.request("replacement")
    expect(
      await f.connection.inputText(
        { ...first, action: "fill" },
        new AbortController().signal,
      ),
    ).toMatchObject({ textVerified: true })
    expect(f.value()).toBe("replacement")
    const clear = await f.request("")
    expect(
      await f.connection.inputText(
        { ...clear, action: "fill" },
        new AbortController().signal,
      ),
    ).toMatchObject({ textVerified: true })
    expect(f.value()).toBe("")
    expect(f.keyDowns()).toBe(1)
    expect(f.keyUps()).toBe(1)
  } finally {
    await f.connection.close()
  }
})

it("releases a clearing key after its dispatch acknowledges cancellation", async () => {
  const f = fixture({ blockKeyDown: true }),
    cancellation = new AbortController()
  try {
    const input = await f.request("")
    const pending = f.connection.inputText(
      { ...input, action: "fill" },
      cancellation.signal,
    )
    await f.insertion
    cancellation.abort()
    expect(f.keyUps()).toBe(0)
    f.release.resolve()
    await expect(pending).rejects.toThrow()
    expect(f.keyDowns()).toBe(1)
    expect(f.keyUps()).toBe(1)
  } finally {
    f.release.resolve()
    await f.connection.close()
  }
})

it("keeps failed key cleanup visible until a later close confirms release", async () => {
  const f = fixture({ failKeyUp: true })
  const input = await f.request("")
  await expect(
    f.connection.inputText(
      { ...input, action: "fill" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "browser_cleanup_failed" })
  await expect(f.connection.close()).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  expect(f.attached()).toBe(true)
  expect(f.keyDowns()).toBe(1)
  f.allowKeyUp()
  await f.connection.close()
  expect(f.keyUps()).toBe(1)
  expect(f.attached()).toBe(false)
})

it("never takes a user debugger to release an uncertain key and accepts target destruction as cleanup", async () => {
  const f = fixture({ loseDebuggerOnKeyDown: true })
  const input = await f.request("")
  await expect(
    f.connection.inputText(
      { ...input, action: "fill" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "browser_cleanup_failed" })
  await expect(f.connection.close()).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  expect(f.keyUps()).toBe(0)
  expect(f.attached()).toBe(true)
  f.destroy()
  await f.connection.close()
  expect(f.keyDowns()).toBe(1)
})

it("accepts a click only through an exact pointer reference without text or raw commands", () => {
  const input = {
    action: "click",
    target,
    reference: "browser_element_00000000-0000-4000-8000-000000000001",
  }
  expect(parseBrowserInputRequest(input)).toEqual(input)
  for (const invalid of [
    { ...input, text: "" },
    { ...input, reference: ownerReference },
    { ...input, action: "mousePressed" },
  ])
    expect(() => parseBrowserInputRequest(invalid)).toThrow()
})

it("shares one modifier release between read cancellation and concurrent close, waiting for its acknowledgement before detaching", async () => {
  const f = fixture({
      pointer: true,
      keys: true,
      blockFocusReadAt: 2,
      blockKeyUp: true,
    }),
    abort = new AbortController()
  let pending: Promise<unknown> | undefined
  try {
    const input = await f.clickRequest()
    pending = f.connection.pressKey(
      {
        action: "press",
        target,
        reference: input.reference,
        key: "r",
        modifiers: ["Meta"],
      },
      abort.signal,
    )
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await f.focusReadStarted.promise
    abort.abort()
    await f.keyUpStarted.promise
    const closing = f.connection.close()
    // A late successful read cannot overtake the in-progress cancellation.
    f.focusReadReply.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(f.attached()).toBe(true)
    expect(
      f.keyEvents.map((event) => ({ type: event.type, key: event.key })),
    ).toEqual([
      { type: "rawKeyDown", key: "Meta" },
      { type: "keyUp", key: "Meta" },
    ])
    f.keyUpReply.resolve()
    await expect(pending).rejects.toMatchObject({
      code: "browser_input_unconfirmed",
    })
    await closing
    expect(f.attached()).toBe(false)
    expect(f.keyUps()).toBe(1)
  } finally {
    f.focusReadReply.resolve()
    f.keyUpReply.resolve()
    await pending?.catch(() => {})
    await f.connection.close()
  }
})

it("ends a pending read when the owned root debugger closes even if the renderer never answers", async () => {
  const f = fixture({ pointer: true, keys: true, blockFocusReadAt: 1 })
  let pending: Promise<unknown> | undefined
  try {
    const input = await f.clickRequest()
    pending = f.connection.pressKey(
      { action: "press", target, reference: input.reference, key: "Enter" },
      new AbortController().signal,
    )
    void pending.catch(() => {})
    await f.focusReadStarted.promise
    await f.connection.close()
    await expect(pending).rejects.toMatchObject({ code: "browser_cancelled" })
    expect(f.keyEvents).toEqual([])
  } finally {
    f.focusReadReply.resolve()
    await pending?.catch(() => {})
    await f.connection.close()
  }
})

it("presses and releases once after hit testing the same captured control", async () => {
  const f = fixture({ pointer: true })
  try {
    const input = await f.clickRequest()
    expect(
      await f.connection.inputPointer(input, new AbortController().signal),
    ).toMatchObject({
      delivered: true,
      point: { x: 20, y: 30 },
      documentChanged: false,
    })
    expect(f.presses()).toBe(1)
    expect(f.releases()).toBe(1)
    await expect(
      f.connection.inputPointer(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_reference_stale" })
    expect(f.presses()).toBe(1)
  } finally {
    await f.connection.close()
  }
})

it("refuses controls covered before or after browser pointer movement without pressing", async () => {
  for (const afterHover of [false, true]) {
    const f = fixture({
      pointer: true,
      covered: !afterHover,
      coverAfterHover: afterHover,
    })
    try {
      const input = await f.clickRequest()
      await expect(
        f.connection.inputPointer(input, new AbortController().signal),
      ).rejects.toMatchObject({ code: "browser_input_unavailable" })
      expect(f.presses()).toBe(0)
      expect(f.releases()).toBe(0)
      expect(f.moves()).toBe(afterHover ? 1 : 0)
    } finally {
      await f.connection.close()
    }
  }
})

it("releases a mouse button after cancellation waits for its press acknowledgement", async () => {
  const f = fixture({ pointer: true, blockPress: true }),
    cancellation = new AbortController()
  try {
    const input = await f.clickRequest(),
      pending = f.connection.inputPointer(input, cancellation.signal)
    await f.insertion
    cancellation.abort()
    expect(f.releases()).toBe(0)
    f.release.resolve()
    await expect(pending).rejects.toThrow()
    expect(f.presses()).toBe(1)
    expect(f.releases()).toBe(1)
  } finally {
    f.release.resolve()
    await f.connection.close()
  }
})

it("does not detach a pressed mouse button until its release is acknowledged", async () => {
  const f = fixture({ pointer: true, failMouseUp: true })
  const input = await f.clickRequest()
  await expect(
    f.connection.inputPointer(input, new AbortController().signal),
  ).rejects.toMatchObject({ code: "browser_cleanup_failed" })
  await expect(f.connection.close()).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  expect(f.attached()).toBe(true)
  expect(f.presses()).toBe(1)
  f.allowMouseUp()
  await f.connection.close()
  expect(f.releases()).toBe(1)
  expect(f.attached()).toBe(false)
})

it("does not use a text reference as a pointer target", async () => {
  const f = fixture()
  try {
    const input = await f.request()
    await expect(
      f.connection.inputPointer(
        { action: "click", target, reference: input.reference },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "browser_reference_stale" })
    expect(f.presses()).toBe(0)
  } finally {
    await f.connection.close()
  }
})

it("parses pointer variants without accepting cross-action fields or unbounded wheel jumps", () => {
  const shared = {
    target,
    reference: "browser_element_00000000-0000-4000-8000-000000000001",
  }
  for (const action of ["hover", "click"])
    expect(parseBrowserInputRequest({ action, ...shared })).toMatchObject({
      action,
    })
  expect(
    parseBrowserInputRequest({
      action: "click",
      ...shared,
      button: "right",
      clickCount: 2,
    }),
  ).toMatchObject({ button: "right", clickCount: 2 })
  expect(
    parseBrowserInputRequest({
      action: "scroll",
      ...shared,
      deltaX: -100,
      deltaY: 400,
    }),
  ).toMatchObject({ deltaX: -100, deltaY: 400 })
  for (const input of [
    { action: "hover", ...shared, button: "left" },
    { action: "scroll", ...shared, deltaX: 0, deltaY: 0 },
    { action: "scroll", ...shared, deltaX: 0, deltaY: 10001 },
    { action: "scroll", ...shared, deltaX: 0, deltaY: Number.NaN },
    { action: "scroll", ...shared, deltaY: 100 },
    { action: "click", ...shared, deltaX: 0, deltaY: 100 },
    { action: "click", ...shared, button: "back" },
    { action: "click", ...shared, clickCount: 3 },
  ])
    expect(() => parseBrowserInputRequest(input)).toThrow()
})

it("hovers without pressing a button and consumes the observation", async () => {
  const f = fixture({ pointer: true })
  try {
    const request = { ...(await f.clickRequest()), action: "hover" as const }
    expect(
      await f.connection.inputPointer(request, new AbortController().signal),
    ).toMatchObject({ delivered: true, action: "hover" })
    expect(f.presses()).toBe(0)
    expect(f.releases()).toBe(0)
    expect(f.moves()).toBe(1)
    await expect(
      f.connection.inputPointer(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_reference_stale" })
  } finally {
    await f.connection.close()
  }
})

it("aims a wheel event at the hit-tested element without changing its CSS-pixel deltas", async () => {
  const f = fixture({ pointer: true })
  try {
    const request = {
      ...(await f.clickRequest()),
      action: "scroll" as const,
      deltaX: -120,
      deltaY: 500,
    }
    expect(
      await f.connection.inputPointer(request, new AbortController().signal),
    ).toMatchObject({ delivered: true, action: "scroll" })
    expect(f.mouseEvents).toEqual([
      { type: "mouseMoved", x: 20, y: 30, buttons: 0 },
      {
        type: "mouseWheel",
        x: 20,
        y: 30,
        buttons: 0,
        deltaX: -120,
        deltaY: 500,
      },
    ])
  } finally {
    await f.connection.close()
  }
})

it("delivers both intentional double-click pairs with the requested button and releases each", async () => {
  for (const button of ["left", "right", "middle"] as const) {
    const f = fixture({ pointer: true })
    try {
      const request = {
        ...(await f.clickRequest()),
        action: "click" as const,
        button,
        clickCount: 2 as const,
      }
      await f.connection.inputPointer(request, new AbortController().signal)
      expect(f.mouseEvents.slice(1)).toEqual([
        {
          type: "mousePressed",
          x: 20,
          y: 30,
          button,
          buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
          clickCount: 1,
        },
        {
          type: "mouseReleased",
          x: 20,
          y: 30,
          button,
          buttons: 0,
          clickCount: 1,
        },
        {
          type: "mousePressed",
          x: 20,
          y: 30,
          button,
          buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
          clickCount: 2,
        },
        {
          type: "mouseReleased",
          x: 20,
          y: 30,
          button,
          buttons: 0,
          clickCount: 2,
        },
      ])
    } finally {
      await f.connection.close()
    }
  }
})

it("stops an intentional double click when its first pair navigates the document", async () => {
  const f = fixture({ pointer: true, navigateAfterRelease: true })
  try {
    const request = {
      ...(await f.clickRequest()),
      action: "click" as const,
      clickCount: 2 as const,
    }
    await expect(
      f.connection.inputPointer(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_input_unconfirmed" })
    expect(f.presses()).toBe(1)
    expect(f.releases()).toBe(1)
  } finally {
    await f.connection.close()
  }
})

it("accepts exact keyboard targets and rejects unvalidated keys, duplicate modifiers and nested values", () => {
  const input = {
    action: "press",
    target,
    reference: "browser_element_00000000-0000-4000-8000-000000000001",
    key: "Enter",
  }
  expect(parseBrowserInputRequest(input)).toEqual(input)
  expect(
    parseBrowserInputRequest({
      ...input,
      key: "p",
      modifiers: ["Meta", "Shift"],
    }),
  ).toMatchObject({ modifiers: ["Meta", "Shift"] })
  for (const override of [
    { key: "你好" },
    { key: "" },
    { key: "F25" },
    { key: "Cmd+A" },
    { modifiers: ["Meta", "Meta"] },
    { modifiers: ["Command"] },
    { modifiers: [["Meta"]] },
    { text: "unrequested" },
    { reference: ownerReference },
    { commands: ["paste"] },
  ])
    expect(() => parseBrowserInputRequest({ ...input, ...override })).toThrow()
})

it("delivers a keyboard chord and unwinds only its owned key and modifiers in reverse order", async () => {
  const f = fixture({ pointer: true, keys: true })
  try {
    const input: BrowserKeyRequest = {
      ...(await f.clickRequest()),
      action: "press",
      key: "p",
      modifiers: ["Meta", "Shift"],
    }
    expect(
      await f.connection.pressKey(input, new AbortController().signal),
    ).toMatchObject({ delivered: true, action: "press", key: "p" })
    expect(f.keyEvents).toEqual([
      {
        type: "rawKeyDown",
        key: "Meta",
        code: "MetaLeft",
        windowsVirtualKeyCode: 91,
        location: 1,
        modifiers: 4,
      },
      {
        type: "rawKeyDown",
        key: "Shift",
        code: "ShiftLeft",
        windowsVirtualKeyCode: 16,
        location: 1,
        modifiers: 12,
      },
      {
        type: "rawKeyDown",
        key: "P",
        code: "KeyP",
        windowsVirtualKeyCode: 80,
        modifiers: 12,
      },
      {
        type: "keyUp",
        key: "P",
        code: "KeyP",
        windowsVirtualKeyCode: 80,
        modifiers: 12,
      },
      {
        type: "keyUp",
        key: "Shift",
        code: "ShiftLeft",
        windowsVirtualKeyCode: 16,
        location: 1,
        modifiers: 4,
      },
      {
        type: "keyUp",
        key: "Meta",
        code: "MetaLeft",
        windowsVirtualKeyCode: 91,
        location: 1,
        modifiers: 0,
      },
    ])
    await expect(
      f.connection.pressKey(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_reference_stale" })
    expect(f.keyDowns()).toBe(3)
  } finally {
    await f.connection.close()
  }
})

it("refuses redirected keyboard focus before sending a modifier or primary key", async () => {
  const f = fixture({ pointer: true, keys: true, redirectFocus: true })
  try {
    const input: BrowserKeyRequest = {
      ...(await f.clickRequest()),
      action: "press",
      key: "p",
      modifiers: ["Meta"],
    }
    await expect(
      f.connection.pressKey(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_input_unavailable" })
    expect(f.keyEvents).toEqual([])
  } finally {
    await f.connection.close()
  }
})

it("waits for canceled key-down acknowledgement before releasing the primary key and modifier", async () => {
  const f = fixture({
    pointer: true,
    keys: true,
    blockKeyDown: true,
    blockKeyDownAt: 2,
  })
  const cancellation = new AbortController()
  try {
    const input: BrowserKeyRequest = {
      ...(await f.clickRequest()),
      action: "press",
      key: "Enter",
      modifiers: ["Meta"],
    }
    const pending = f.connection.pressKey(input, cancellation.signal)
    const rejected = expect(pending).rejects.toThrow()
    // The first modifier resolves insertion; wait for the blocked primary key.
    await expect.poll(f.keyDowns).toBe(2)
    cancellation.abort()
    expect(f.keyUps()).toBe(0)
    f.release.resolve()
    await rejected
    expect(
      f.keyEvents
        .filter((event) => event.type === "keyUp")
        .map((event) => event.key),
    ).toEqual(["Enter", "Meta"])
  } finally {
    f.release.resolve()
    await f.connection.close()
  }
})

it("retains only unreleased modifiers for cleanup retries and never repeats a confirmed key-up", async () => {
  const f = fixture({ pointer: true, keys: true, failKeyUpKey: "Shift" })
  const input: BrowserKeyRequest = {
    ...(await f.clickRequest()),
    action: "press",
    key: "p",
    modifiers: ["Meta", "Shift"],
  }
  await expect(
    f.connection.pressKey(input, new AbortController().signal),
  ).rejects.toMatchObject({ code: "browser_cleanup_failed" })
  expect(f.attached()).toBe(true)
  f.allowKeyUp()
  await f.connection.close()
  expect(
    f.keyEvents.filter((event) => event.type === "keyUp" && event.key === "P"),
  ).toHaveLength(1)
  expect(f.keyUps()).toBe(3)
  expect(f.keyDowns()).toBe(3)
  expect(f.attached()).toBe(false)
})
