import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserFrames } from "../../src/desktop/browser-frames.ts"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"
import { parseBrowserObservationRequest } from "../../src/protocol/desktop-browser.ts"

const target = {
  tabId: "owned",
  webContentsId: 17,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const signal = () => new AbortController().signal

it.each([
  "detach",
  "close",
])("ends a pending frame query when its session %s occurs without waiting for the dead renderer", async (terminal) => {
  const events = new EventEmitter()
  const frames = new BrowserFrames({
    on: events.on.bind(events),
    off: events.off.bind(events),
  } as unknown as WebContents["debugger"])
  const started = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<unknown>()
  const pending = frames.list(async (method, _params, sessionId) => {
    if (method === "Target.setAutoAttach") {
      if (!sessionId)
        events.emit("message", {}, "Target.attachedToTarget", {
          sessionId: "old_renderer",
          targetInfo: { type: "iframe", parentFrameId: "main" },
        })
      return {}
    }
    if (method !== "Page.getFrameTree") throw new Error("Unexpected query")
    if (!sessionId)
      return {
        frameTree: {
          frame: {
            id: "main",
            loaderId: "root_v1",
            url: "https://owned.test/",
          },
        },
      }
    started.resolve()
    return reply.promise
  }, 0)
  try {
    await started.promise
    const ended = expect(pending).rejects.toMatchObject({
      code:
        terminal === "detach" ? "browser_frame_stale" : "browser_unavailable",
    })
    if (terminal === "detach")
      events.emit("message", {}, "Target.detachedFromTarget", {
        sessionId: "old_renderer",
      })
    else frames.close()
    await ended
    expect(frames.ownsSession("old_renderer")).toBe(false)
  } finally {
    frames.close()
    reply.resolve({})
  }
  expect(events.listenerCount("message")).toBe(0)
})

function fixture(
  options: {
    manyLocal?: number
    overflow?: boolean
    dropOnKeyDown?: boolean
  } = {},
) {
  const events = new EventEmitter(),
    calls: {
      method: string
      params: Record<string, unknown>
      sessionId?: string
    }[] = []
  let attached = false,
    mainLoader = "main_v1",
    remoteLoader = "remote_v1",
    remoteParent = "local",
    remoteSession = "remote_session"
  const configured = new Set<string>()
  const ids: Record<string, number> = {
    main: 1,
    local: 2,
    remote: 3,
    remote_local: 4,
    leaf: 5,
  }
  const fields = new Map<
    string,
    { value: string; start: number; end: number }
  >()
  const groups = new Map<string, string | undefined>()
  let focused = "",
    destroyed = false
  const field = (id: string) => {
    let value = fields.get(id)
    if (!value) {
      value = { value: id, start: id.length, end: id.length }
      fields.set(id, value)
    }
    return value
  }
  const expectedSession = (id: string) =>
    id === "remote" || id === "remote_local"
      ? remoteSession
      : id === "leaf"
        ? `${remoteSession}_leaf`
        : undefined
  const requireSession = (id: string, sessionId?: string) => {
    if (expectedSession(id) !== sessionId)
      throw new Error("Input crossed frame renderer ownership")
  }
  const insert = (id: string, text: string) => {
    const value = field(id)
    value.value =
      value.value.slice(0, value.start) + text + value.value.slice(value.end)
    value.start += text.length
    value.end = value.start
  }
  const frame = (
    id: string,
    url: string,
    loaderId = `${id}_v1`,
    parentId?: string,
  ) => ({ id, url, loaderId, name: id, ...(parentId ? { parentId } : {}) })
  const attachRemote = (
    sessionId: string,
    parentFrameId: string,
    parentSessionId?: string,
  ) =>
    events.emit(
      "message",
      {},
      "Target.attachedToTarget",
      { sessionId, targetInfo: { type: "iframe", parentFrameId } },
      parentSessionId,
    )
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
    async sendCommand(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) })
      if (method === "Target.setAutoAttach") {
        const key = sessionId ?? ""
        if (!configured.has(key)) {
          configured.add(key)
          if (!sessionId) {
            if (options.overflow)
              for (let index = 0; index < 129; index++)
                attachRemote(`overflow_${index}`, "main")
            else if (!options.manyLocal) attachRemote(remoteSession, "local")
          } else if (sessionId === remoteSession)
            attachRemote(`${remoteSession}_leaf`, "remote_local", remoteSession)
        }
        return {}
      }
      if (method === "Page.getFrameTree") {
        if (!sessionId)
          return {
            frameTree: {
              frame: frame("main", "https://owned.test/", mainLoader),
              childFrames: options.manyLocal
                ? Array.from({ length: options.manyLocal }, (_, index) => ({
                    frame: frame(
                      `local_${index}`,
                      `https://owned.test/${index}`,
                    ),
                  }))
                : [{ frame: frame("local", "https://owned.test/local") }],
            },
          }
        if (sessionId === remoteSession)
          return {
            frameTree: {
              frame: frame(
                "remote",
                "https://cross.test/remote",
                remoteLoader,
                remoteParent,
              ),
              childFrames: [
                { frame: frame("remote_local", "https://cross.test/local") },
              ],
            },
          }
        if (sessionId === `${remoteSession}_leaf`)
          return {
            frameTree: {
              frame: frame(
                "leaf",
                "https://owned.test/leaf",
                "leaf_v1",
                "remote_local",
              ),
            },
          }
        throw new Error("Frame query used an unowned session")
      }
      if (method === "Accessibility.getFullAXTree") {
        const id = String(params.frameId)
        const expected =
          id === "remote" || id === "remote_local"
            ? remoteSession
            : id === "leaf"
              ? `${remoteSession}_leaf`
              : undefined
        if (sessionId !== expected)
          throw new Error("AX query crossed frame renderer ownership")
        return {
          nodes: [
            {
              nodeId: id,
              backendDOMNodeId: ids[id] ?? 17,
              role: { value: "textbox" },
              name: { value: `Field ${id}` },
              value: { value: field(id).value },
            },
          ],
        }
      }
      if (method === "Page.createIsolatedWorld") {
        const id = String(params.frameId)
        requireSession(id, sessionId)
        return { executionContextId: 1000 + (ids[id] ?? 0) }
      }
      if (method === "DOM.resolveNode" || method === "DOM.focus") {
        const id = Object.keys(ids).find(
          (id) => ids[id] === params.backendNodeId,
        )
        if (!id) throw new Error("Unknown input node")
        requireSession(id, sessionId)
        if (method === "DOM.focus") {
          focused = id
          return {}
        }
        if (params.executionContextId !== 1000 + (ids[id] ?? 0))
          throw new Error("Wrong frame execution context")
        groups.set(String(params.objectGroup), sessionId)
        return { object: { objectId: id } }
      }
      if (method === "Runtime.callFunctionOn") {
        const id = String(params.objectId)
        requireSession(id, sessionId)
        if (!Array.isArray(params.arguments))
          return { result: { value: focused === id } }
        const value = field(id),
          args = params.arguments as { value: boolean }[]
        if (args[1]?.value) {
          value.start = 0
          value.end = value.value.length
        }
        return {
          result: {
            value: {
              ok: focused === id,
              value: value.value,
              start: value.start,
              end: value.end,
            },
          },
        }
      }
      if (method === "Input.insertText") {
        if (sessionId !== undefined)
          throw new Error("Text input left the root session")
        insert(focused, String(params.text))
        return {}
      }
      if (method === "Input.dispatchKeyEvent") {
        if (sessionId !== undefined)
          throw new Error("Keyboard input left the root session")
        if (params.type !== "keyUp") {
          const childSession = expectedSession(focused)
          if (options.dropOnKeyDown && childSession)
            events.emit("message", {}, "Target.detachedFromTarget", {
              sessionId: childSession,
            })
          const value = field(focused)
          if (
            Array.isArray(params.commands) &&
            params.commands.includes("selectAll")
          ) {
            value.start = 0
            value.end = value.value.length
          } else if (typeof params.text === "string")
            insert(focused, params.text)
          else if (params.key === "Backspace") insert(focused, "")
        }
        return {}
      }
      if (method === "Runtime.releaseObjectGroup") {
        const group = String(params.objectGroup)
        if (groups.has(group) && groups.get(group) !== sessionId)
          throw new Error("Object group cleanup crossed renderer ownership")
        groups.delete(group)
        return {}
      }
      throw new Error(`Unexpected frame command ${method}`)
    },
  }
  const connection = new BrowserDocumentConnection({
    debugger: debug,
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => false,
    getURL: () => "https://owned.test/",
  } as unknown as WebContents)
  return {
    connection,
    calls,
    events,
    attached: () => attached,
    destroy() {
      destroyed = true
      debug.detach()
    },
    change(kind: string) {
      if (kind === "document") remoteLoader = "remote_v2"
      if (kind === "parent") remoteParent = "main"
      if (kind === "root") mainLoader = "main_v2"
      if (kind === "renderer") {
        events.emit("message", {}, "Target.detachedFromTarget", {
          sessionId: remoteSession,
        })
        remoteSession = "replacement_session"
        attachRemote(remoteSession, "local")
      }
    },
    async control(id: string) {
      const catalog = await connection.frames(0, signal())
      const frame = (
        catalog.frames as { frameId: string; frameReference: string }[]
      ).find((frame) => frame.frameId === id)
      if (!frame) throw new Error("Missing observed frame control")
      const observed = await connection.observe(signal(), frame.frameReference)
      const control = (
        observed.nodes as {
          inputReference: string
          elementReference: string
          value: string
        }[]
      )[0]
      if (!control?.inputReference || !control.elementReference)
        throw new Error("Missing frame input references")
      return control
    },
    async catalog(offset = 0) {
      const output = await connection.frames(offset, signal())
      return {
        ...output,
        nextOffset: output.nextOffset,
        frames: output.frames as {
          frameReference: string
          frameId: string
          remote: boolean
          parentFrameId?: string
        }[],
      }
    },
  }
}

it("accepts catalog frame references but refuses raw frame IDs, sessions and invalid pagination", () => {
  expect(
    parseBrowserObservationRequest({ action: "frames", target, offset: 64 }),
  ).toMatchObject({ action: "frames", offset: 64 })
  expect(
    parseBrowserObservationRequest({
      action: "observe",
      target,
      frameReference: "browser_frame_00000000-0000-4000-8000-000000000001",
    }),
  ).toMatchObject({ action: "observe" })
  for (const input of [
    { action: "observe", target, frameId: "raw" },
    { action: "observe", target, frameReference: "raw" },
    { action: "frames", target, sessionId: "foreign" },
    { action: "frames", target, offset: -1 },
    {
      action: "frames",
      target,
      frameReference: "browser_frame_00000000-0000-4000-8000-000000000001",
    },
  ])
    expect(() => parseBrowserObservationRequest(input)).toThrow()
})

it("routes same-process, cross-process and nested cross-process frame observations within the owned tab", async () => {
  const f = fixture()
  try {
    const catalog = await f.catalog()
    expect(catalog.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          frameId: "local",
          remote: false,
          parentFrameId: "main",
        }),
        expect.objectContaining({
          frameId: "remote",
          remote: true,
          parentFrameId: "local",
        }),
        expect.objectContaining({
          frameId: "leaf",
          remote: true,
          parentFrameId: "remote_local",
        }),
      ]),
    )
    for (const id of ["local", "remote", "remote_local", "leaf"]) {
      const row = catalog.frames.find((frame) => frame.frameId === id)
      if (!row) throw new Error("Missing owned frame")
      const observed = await f.connection.observe(signal(), row.frameReference)
      expect(observed.mainDocument).toMatchObject({
        frameId: "main",
        url: "https://owned.test/",
      })
      expect(observed.nodes).toEqual([
        expect.objectContaining({ name: `Field ${id}`, value: id }),
      ])
      expect(observed.nodes).toEqual([
        expect.objectContaining({
          inputReference: expect.any(String),
          elementReference: expect.any(String),
        }),
      ])
    }
    const main = await f.connection.observe(signal())
    expect(main.nodes).toEqual([
      expect.objectContaining({
        name: "Field main",
        inputReference: expect.any(String),
        elementReference: expect.any(String),
      }),
    ])
    const configurations = f.calls.filter(
      (call) => call.method === "Target.setAutoAttach",
    )
    expect(configurations).toHaveLength(3)
    expect(
      configurations.every(
        (call) => call.params.waitForDebuggerOnStart === false,
      ),
    ).toBe(true)
    expect(configurations[0]?.params.filter).toEqual([
      { type: "iframe", exclude: false },
      { exclude: true },
    ])
  } finally {
    await f.connection.close()
  }
  expect(f.events.listenerCount("message")).toBe(0)
  expect(f.attached()).toBe(false)
})

it.each([
  "document",
  "parent",
  "renderer",
  "root",
])("refuses frame references after their %s changes even when the child URL stays the same", async (kind) => {
  const f = fixture()
  try {
    const row = (await f.catalog()).frames.find(
      (frame) => frame.frameId === "remote",
    )
    if (!row) throw new Error("Missing remote frame")
    f.change(kind)
    await expect(
      f.connection.observe(signal(), row.frameReference),
    ).rejects.toMatchObject({ code: "browser_frame_stale" })
  } finally {
    await f.connection.close()
  }
})

it("invalidates refreshed frame catalogs and never accepts references from another connection", async () => {
  const first = fixture(),
    other = fixture()
  try {
    const token = (await first.catalog()).frames[0]?.frameReference
    if (!token) throw new Error("Missing catalog reference")
    await first.catalog()
    await expect(
      first.connection.observe(signal(), token),
    ).rejects.toMatchObject({ code: "browser_frame_stale" })
    await expect(
      other.connection.observe(signal(), token),
    ).rejects.toMatchObject({ code: "browser_frame_stale" })
    expect(other.calls).toEqual([])
  } finally {
    await first.connection.close()
    await other.connection.close()
  }
})

it("keeps later frames reachable through catalog pagination", async () => {
  const f = fixture({ manyLocal: 80 })
  try {
    const first = await f.catalog()
    expect(first.nextOffset).toBe(64)
    const second = await f.catalog(64)
    expect(second.nextOffset).toBeUndefined()
    expect(
      new Set([...first.frames, ...second.frames].map((frame) => frame.frameId))
        .size,
    ).toBe(81)
    expect(second.frames).toContainEqual(
      expect.objectContaining({ frameId: "local_79" }),
    )
  } finally {
    await f.connection.close()
  }
})

it("refuses frame-session overflow before querying unknown renderers", async () => {
  const f = fixture({ overflow: true })
  try {
    await expect(f.connection.frames(0, signal())).rejects.toMatchObject({
      code: "browser_frame_limit",
    })
    expect(f.calls).toHaveLength(1)
  } finally {
    await f.connection.close()
  }
})

it("refuses a frame tree that exceeds the host identity bookkeeping bound", async () => {
  const f = fixture({ manyLocal: 512 })
  try {
    await expect(f.connection.frames(0, signal())).rejects.toMatchObject({
      code: "browser_frame_limit",
    })
  } finally {
    await f.connection.close()
  }
})

it("focuses exact frame DOM and sends text through the owned root input session", async () => {
  const f = fixture()
  try {
    for (const id of ["local", "remote", "leaf"]) {
      const node = await f.control(id)
      expect(
        await f.connection.inputText(
          {
            action: "fill",
            target,
            reference: node.inputReference,
            text: `changed_${id}你好`,
          },
          signal(),
        ),
      ).toMatchObject({ delivered: true, textVerified: true })
      expect((await f.control(id)).value).toBe(`changed_${id}你好`)
    }
    expect(
      f.calls
        .filter((call) => call.method === "Input.insertText")
        .map((call) => call.sessionId),
    ).toEqual([undefined, undefined, undefined])
    expect(
      f.calls
        .filter((call) => call.method === "DOM.resolveNode")
        .map((call) => call.sessionId),
    ).toEqual([undefined, "remote_session", "remote_session_leaf"])
  } finally {
    await f.connection.close()
  }
})

it.each([
  "local",
  "leaf",
])("preserves keyboard selection and text replacement in the %s frame without reporting a false document change", async (id) => {
  const f = fixture()
  try {
    const node = await f.control(id)
    expect(
      await f.connection.pressKey(
        {
          action: "press",
          target,
          reference: node.elementReference,
          key: "a",
          modifiers: ["Meta"],
        },
        signal(),
      ),
    ).toMatchObject({ delivered: true, documentChanged: false })
    const selected = await f.control(id)
    await f.connection.inputText(
      {
        action: "type",
        target,
        reference: selected.inputReference,
        text: "replaced你好",
      },
      signal(),
    )
    expect((await f.control(id)).value).toBe("replaced你好")
  } finally {
    await f.connection.close()
  }
})

it("refuses a replaced frame renderer before focusing or sending input", async () => {
  const f = fixture()
  try {
    const node = await f.control("remote")
    f.change("renderer")
    await expect(
      f.connection.inputText(
        {
          action: "fill",
          target,
          reference: node.inputReference,
          text: "must not dispatch",
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "browser_frame_stale" })
    expect(f.calls.some((call) => /^(Input|DOM)\./.test(call.method))).toBe(
      false,
    )
  } finally {
    await f.connection.close()
  }
})

it("releases root-owned keys after a child renderer disappears without retargeting its DOM cleanup", async () => {
  const f = fixture({ dropOnKeyDown: true })
  try {
    const node = await f.control("remote")
    expect(
      await f.connection.pressKey(
        {
          action: "press",
          target,
          reference: node.elementReference,
          key: "Enter",
        },
        signal(),
      ),
    ).toMatchObject({ delivered: true, documentChanged: true })
    const keys = f.calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent",
    )
    expect(
      keys.map((call) => ({
        type: call.params.type,
        sessionId: call.sessionId,
      })),
    ).toEqual([
      { type: "keyDown", sessionId: undefined },
      { type: "keyUp", sessionId: undefined },
    ])
    expect(
      f.calls.some((call) => call.method === "Runtime.releaseObjectGroup"),
    ).toBe(false)
    expect((await f.connection.observe(signal())).nodes).toEqual([
      expect.objectContaining({ name: "Field main" }),
    ])
  } finally {
    await f.connection.close()
  }
  expect(f.attached()).toBe(false)
})

it("refuses child pointer input until frame geometry is available instead of dispatching local coordinates to the main frame", async () => {
  const f = fixture()
  try {
    const node = await f.control("local")
    await expect(
      f.connection.inputPointer(
        { action: "click", target, reference: node.elementReference },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "browser_frame_pointer_unavailable" })
    expect(
      f.calls.some((call) => call.method === "Input.dispatchMouseEvent"),
    ).toBe(false)
  } finally {
    await f.connection.close()
  }
})
