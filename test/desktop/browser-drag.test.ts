import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserDrag } from "../../src/desktop/browser-drag.ts"
import { BrowserPendingMutations } from "../../src/desktop/browser-mutations.ts"
import { parseBrowserDragRequest } from "../../src/protocol/desktop-browser.ts"

const target = {
  tabId: "owned",
  webContentsId: 17,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const reference = "browser_element_00000000-0000-4000-8000-000000000001"
const dragId = "browser_drag_00000000-0000-4000-8000-000000000001"

function fixture() {
  const events = new EventEmitter(),
    closed = new AbortController(),
    mutations = new BrowserPendingMutations(() => destroyed),
    drag = new BrowserDrag({
      on: events.on.bind(events),
      off: events.off.bind(events),
    } as unknown as WebContents["debugger"]),
    calls: {
      method: string
      params: Record<string, unknown>
      sessionId?: string
    }[] = [],
    pending = Promise.withResolvers<void>()
  let destroyed = false,
    deadline = new AbortController(),
    blockCancel = false,
    blockFocusRestore = false,
    native = true
  const emit = (method: string, params: object, sessionId = "source_session") =>
    events.emit("message", {}, method, params, sessionId)
  const scope = {
    document: {
      frameId: "source",
      documentId: "v1",
      url: "https://owned.test/",
    },
    frame: { reference: "frame_ticket", sessionId: "source_session" },
    closed: closed.signal,
  }
  const command = async (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    confirmed?: (result: unknown) => void,
  ) => {
    return mutations.run(async () => {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) })
      let result: unknown = {}
      if (method === "Runtime.enable")
        emit("Runtime.executionContextCreated", {
          context: {
            name: "yakitori-browser-input",
            uniqueId: "context_original",
            auxData: { frameId: "source" },
          },
        })
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration === "function(){return this.finish()}")
          result = { result: { value: native } }
        else if (params.functionDeclaration === "function(){this.cleanup()}")
          result = {}
        else result = { result: { objectId: "original_drag_hook" } }
      }
      if (
        method === "Input.dispatchDragEvent" &&
        params.type === "dragCancel" &&
        blockCancel
      )
        await pending.promise
      if (
        method === "Emulation.setFocusEmulationEnabled" &&
        params.enabled === false &&
        blockFocusRestore
      )
        await pending.promise
      confirmed?.(result)
      return result
    }, deadline.signal)
  }
  return {
    drag,
    scope,
    command,
    calls,
    emit,
    events,
    closed,
    pending,
    mutations,
    arm: () => drag.arm(scope, "source_node", "owned_group", command),
    capture: (data: unknown, session = "") =>
      emit("Input.dragIntercepted", { data }, session),
    blockCancel: () => {
      blockCancel = true
    },
    blockFocusRestore: () => {
      blockFocusRestore = true
    },
    expire: () => deadline.abort(new Error("Native ACK deadline")),
    renew: () => {
      deadline = new AbortController()
    },
    pointerOnly: () => {
      native = false
    },
    destroy: () => {
      destroyed = true
    },
    cleanup: async () => {
      mutations.assertCompleted()
      await drag.cleanup(destroyed)
    },
  }
}

it("parses one-use drag sources without accepting page code, coordinates or cross-action fields", () => {
  expect(
    parseBrowserDragRequest({ action: "drag_prepare", target, reference }),
  ).toEqual({ action: "drag_prepare", target, reference })
  expect(
    parseBrowserDragRequest({ action: "drag_drop", target, reference, dragId }),
  ).toMatchObject({ dragId })
  for (const input of [
    { action: "drag_prepare", target, reference, dragId },
    { action: "drag_drop", target, reference },
    { action: "drag_cancel", target, reference, dragId },
    { action: "drag_drop", target, reference, dragId, x: 12 },
    { action: "drag_drop", target, reference, dragId, script: "drop()" },
  ])
    expect(() => parseBrowserDragRequest(input)).toThrow()
})

it("routes captured HTML5 data through root input while cleaning the original source renderer", async () => {
  const f = fixture(),
    data = {
      items: [{ mimeType: "text/plain", data: "你好 猫 🌍" }],
      dragOperationsMask: -1,
    }
  await f.arm()
  f.capture({ files: ["/must/not/read"] }, "unrelated_session")
  f.capture(data)
  expect(
    await f.drag.transfer(
      { x: 200, y: 120 },
      new AbortController().signal,
      async () => {},
    ),
  ).toBe(true)
  await f.cleanup()
  expect(
    f.calls.filter((call) => call.method === "Input.dispatchDragEvent"),
  ).toEqual(
    ["dragEnter", "dragOver", "drop"].map((type) => ({
      method: "Input.dispatchDragEvent",
      params: { type, x: 200, y: 120, data },
    })),
  )
  expect(
    f.calls.findLast((call) => call.method === "Runtime.callFunctionOn"),
  ).toMatchObject({
    sessionId: "source_session",
    params: {
      objectId: "original_drag_hook",
      functionDeclaration: "function(){this.cleanup()}",
    },
  })
  expect(f.calls.at(-1)).toEqual({
    method: "Emulation.setFocusEmulationEnabled",
    params: { enabled: false },
  })
  expect(f.drag.active).toBe(false)
  f.drag.close()
  expect(f.events.listenerCount("message")).toBe(0)
})

it.each(
  [
    { items: [], dragOperationsMask: 1, files: ["/private/file"] },
    {
      items: [{ mimeType: "text/plain", data: "猫".repeat(23000) }],
      dragOperationsMask: 1,
    },
    {
      items: Array.from({ length: 65 }, () => ({
        mimeType: "text/plain",
        data: "",
      })),
      dragOperationsMask: 1,
    },
    { items: [{ mimeType: "text/plain", data: 1 }], dragOperationsMask: 1 },
  ].map((data, index) => ({ data, case: index })),
)("refuses unsafe native transfer data and cancels before releasing interception ($case)", async ({
  data,
}) => {
  const f = fixture()
  await f.arm()
  f.capture(data)
  await expect(
    f.drag.transfer(
      { x: 10, y: 20 },
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "browser_drag_unavailable" })
  await f.cleanup()
  expect(
    f.calls
      .filter((call) => call.method === "Input.dispatchDragEvent")
      .map((call) => call.params.type),
  ).toEqual(["dragCancel"])
  expect(
    f.calls.findIndex((call) => call.params.type === "dragCancel"),
  ).toBeLessThan(f.calls.findIndex((call) => call.params.enabled === false))
  f.drag.close()
})

it("retains an unacknowledged drag cancel and retires its late positive receipt without repeating it", async () => {
  const f = fixture()
  await f.arm()
  f.blockCancel()
  const cleanup = f.cleanup()
  await expect
    .poll(() => f.calls.some((call) => call.params.type === "dragCancel"))
    .toBe(true)
  f.expire()
  await expect(cleanup).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  expect(f.drag.active).toBe(true)
  await expect(f.cleanup()).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  expect(f.calls.some((call) => call.params.enabled === false)).toBe(false)
  f.pending.resolve()
  await expect
    .poll(() => {
      try {
        f.mutations.assertCompleted()
        return true
      } catch {
        return false
      }
    })
    .toBe(true)
  f.renew()
  await f.cleanup()
  expect(
    f.calls.filter((call) => call.params.type === "dragCancel"),
  ).toHaveLength(1)
  expect(f.drag.active).toBe(false)
  f.drag.close()
})

it("retires a destroyed source realm but still cancels native dragging through the root session", async () => {
  const f = fixture()
  await f.arm()
  f.emit("Runtime.executionContextDestroyed", {
    executionContextUniqueId: "context_original",
  })
  await f.cleanup()
  expect(
    f.calls.some(
      (call) =>
        call.params.functionDeclaration === "function(){this.cleanup()}",
    ),
  ).toBe(false)
  expect(
    f.calls.filter((call) => call.params.type === "dragCancel"),
  ).toHaveLength(1)
  f.drag.close()
})

it("does not dispatch a native drop after ordinary cancellation", async () => {
  const f = fixture(),
    cancelled = new AbortController()
  await f.arm()
  f.capture({ items: [], dragOperationsMask: 1 })
  cancelled.abort(new Error("Stop drag"))
  await expect(
    f.drag.transfer({ x: 10, y: 20 }, cancelled.signal, async () => {}),
  ).rejects.toThrow("Stop drag")
  await f.cleanup()
  expect(
    f.calls
      .filter((call) => call.method === "Input.dispatchDragEvent")
      .map((call) => call.params.type),
  ).toEqual(["dragCancel"])
  f.drag.close()
})

it("stops native transfer when a dragenter handler replaces the observed destination", async () => {
  const f = fixture()
  await f.arm()
  f.capture({
    items: [{ mimeType: "text/plain", data: "owned" }],
    dragOperationsMask: 1,
  })
  let checks = 0
  await expect(
    f.drag.transfer(
      { x: 10, y: 20 },
      new AbortController().signal,
      async () => {
        if (++checks === 2) throw new Error("The destination document changed")
      },
    ),
  ).rejects.toThrow("The destination document changed")
  await f.cleanup()
  expect(
    f.calls
      .filter((call) => call.method === "Input.dispatchDragEvent")
      .map((call) => call.params.type),
  ).toEqual(["dragEnter", "dragCancel"])
  f.drag.close()
})

it("keeps emulated page focus until held-input release and confirms late focus restoration once", async () => {
  const f = fixture()
  await f.arm()
  await f.drag.settle(false)
  expect(
    f.calls
      .filter((call) => call.method === "Emulation.setFocusEmulationEnabled")
      .map((call) => call.params.enabled),
  ).toEqual([true])
  expect(f.drag.active).toBe(true)
  f.blockFocusRestore()
  const cleanup = f.cleanup()
  await expect
    .poll(() =>
      f.calls.some(
        (call) =>
          call.method === "Emulation.setFocusEmulationEnabled" &&
          call.params.enabled === false,
      ),
    )
    .toBe(true)
  f.expire()
  await expect(cleanup).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  expect(f.drag.active).toBe(true)
  await expect(f.cleanup()).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  f.pending.resolve()
  await expect
    .poll(() => {
      try {
        f.mutations.assertCompleted()
        return true
      } catch {
        return false
      }
    })
    .toBe(true)
  f.renew()
  await f.cleanup()
  expect(
    f.calls
      .filter((call) => call.method === "Emulation.setFocusEmulationEnabled")
      .map((call) => call.params.enabled),
  ).toEqual([true, false])
  expect(f.drag.active).toBe(false)
  f.drag.close()
})
