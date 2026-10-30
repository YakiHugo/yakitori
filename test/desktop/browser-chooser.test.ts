import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserFileChooser } from "../../src/desktop/browser-chooser.ts"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"

function fixture() {
  const events = new EventEmitter(),
    closed = new AbortController(),
    calls: {
      method: string
      params?: Record<string, unknown>
      sessionId?: string
    }[] = []
  const chooser = new BrowserFileChooser({
    on: events.on.bind(events),
    off: events.off.bind(events),
  } as unknown as WebContents["debugger"])
  const scope = {
    document: {
      frameId: "frame",
      documentId: "v1",
      url: "https://owned.test/",
    },
    frame: { reference: "frame_ticket", sessionId: "owned_session" },
    closed: closed.signal,
  }
  const command = async (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => {
    calls.push({
      method,
      ...(params ? { params } : {}),
      ...(sessionId ? { sessionId } : {}),
    })
    return {}
  }
  const emit = (
    params: object,
    sessionId = "owned_session",
    method = "Page.fileChooserOpened",
  ) => events.emit("message", {}, method, params, sessionId)
  return { chooser, events, closed, calls, scope, command, emit }
}

it("arms one original child session without selecting files and ignores other renderer events", async () => {
  const f = fixture()
  try {
    await f.chooser.arm(f.scope, f.command)
    expect(f.calls).toEqual([
      { method: "Page.enable", params: {}, sessionId: "owned_session" },
      {
        method: "Page.setInterceptFileChooserDialog",
        params: { enabled: true },
        sessionId: "owned_session",
      },
    ])
    f.emit({ frameId: "frame", backendNodeId: 17 }, "another_session")
    expect(f.chooser.inspect().backendNodeId).toBeUndefined()
    f.emit({ frameId: "frame", backendNodeId: 17 })
    expect(f.chooser.inspect()).toEqual({
      scope: expect.objectContaining(f.scope),
      backendNodeId: 17,
    })
    expect(f.calls).toHaveLength(2)
    await expect(f.chooser.arm(f.scope, f.command)).rejects.toMatchObject({
      code: "browser_chooser_armed",
    })
    f.chooser.selected({
      kind: "element",
      backendNodeId: 17,
      document: f.scope.document,
      frame: f.scope.frame,
    })
    expect(f.chooser.inspect().backendNodeId).toBeUndefined()
    expect(await f.chooser.disarm(f.command)).toBe(true)
    expect(f.calls.at(-1)).toEqual({
      method: "Page.setInterceptFileChooserDialog",
      params: { enabled: false },
      sessionId: "owned_session",
    })
    expect(() => f.chooser.inspect()).toThrow(/Arm the current document/)
  } finally {
    f.chooser.close()
  }
  expect(f.events.listenerCount("message")).toBe(0)
})

it.each([
  "duplicate",
  "unsupported",
  "navigation",
  "outside",
])("refuses %s chooser state instead of guessing an input", async (failure) => {
  const f = fixture()
  try {
    await f.chooser.arm(f.scope, f.command)
    if (failure === "unsupported") f.emit({ frameId: "frame" })
    else if (failure === "outside")
      f.emit({ frameId: "another_frame", backendNodeId: 17 })
    else if (failure === "navigation")
      f.emit(
        { frame: { id: "frame", loaderId: "v2" } },
        "owned_session",
        "Page.frameNavigated",
      )
    else {
      f.emit({ frameId: "frame", backendNodeId: 17 })
      f.emit({ frameId: "frame", backendNodeId: 18 })
    }
    expect(() => f.chooser.inspect()).toThrow()
    await f.chooser.disarm(f.command)
    await f.chooser.arm(f.scope, f.command)
    expect(f.chooser.inspect().backendNodeId).toBeUndefined()
  } finally {
    f.chooser.close()
  }
})

it("keeps interception ownership when disabling fails and retries only cleanup", async () => {
  const f = fixture()
  try {
    await f.chooser.arm(f.scope, f.command)
    await expect(
      f.chooser.disarm(async () => {
        throw new Error("Disable failed")
      }),
    ).rejects.toThrow("Disable failed")
    await expect(f.chooser.arm(f.scope, f.command)).rejects.toMatchObject({
      code: "browser_chooser_armed",
    })
    await f.chooser.disarm(f.command)
    expect(await f.chooser.disarm(f.command)).toBe(false)
  } finally {
    f.chooser.close()
  }
})

it("retires a dead original renderer without sending cleanup into a replacement", async () => {
  const f = fixture()
  try {
    await f.chooser.arm(f.scope, f.command)
    f.closed.abort()
    f.emit({ frameId: "frame", backendNodeId: 17 })
    expect(() => f.chooser.inspect()).toThrow()
    await f.chooser.disarm(async () => {
      throw new Error("Must not send into a retired session")
    })
    expect(f.calls).toHaveLength(2)
  } finally {
    f.chooser.close()
  }
})

function pendingConfiguration() {
  const events = new EventEmitter(),
    started = Promise.withResolvers<void>(),
    reply = Promise.withResolvers<unknown>(),
    interception: boolean[] = []
  let attached = false
  const disconnect = () => {
    attached = false
    events.emit("detach")
  }
  const connection = new BrowserDocumentConnection({
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => false,
    getURL: () => "https://owned.test/",
    debugger: {
      on: events.on.bind(events),
      off: events.off.bind(events),
      attach: () => {
        attached = true
      },
      isAttached: () => attached,
      detach: disconnect,
      async sendCommand(method: string, params: Record<string, unknown> = {}) {
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: { id: "main", loaderId: "v1", url: "https://owned.test/" },
            },
          }
        if (method === "Page.enable") {
          started.resolve()
          return reply.promise
        }
        if (method === "Page.setInterceptFileChooserDialog") {
          interception.push(params.enabled === true)
          return {}
        }
        throw new Error(`Unexpected chooser command ${method}`)
      },
    },
  } as unknown as WebContents)
  const arm = (signal: AbortSignal) =>
    connection.fileChooser(
      {
        action: "chooser_arm",
        target: {
          tabId: "owned",
          webContentsId: 17,
          instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
        },
        fromUrl: "https://owned.test/",
      },
      signal,
    )
  const clean = async () => {
    reply.resolve({})
    await new Promise<void>((done) => setImmediate(done))
    await connection.close()
  }
  return { connection, started, reply, interception, disconnect, arm, clean }
}

it("waits for configuration acknowledgement on cancellation and never enables interception afterward", async () => {
  const f = pendingConfiguration(),
    cancel = new AbortController()
  try {
    const reason = new Error("Cancelled chooser arm"),
      pending = f.arm(cancel.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await f.started.promise
    cancel.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    f.reply.resolve({})
    await rejected
    expect(f.interception).toEqual([false])
  } finally {
    await f.clean()
  }
})

it("quarantines lost configuration completion until the original acknowledgement arrives", async () => {
  const f = pendingConfiguration()
  try {
    const pending = f.arm(new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "browser_cleanup_failed",
    })
    await f.started.promise
    f.disconnect()
    await rejected
    expect(() => f.connection.assertInputIdle()).toThrow(
      /no confirmed completion/,
    )
    await expect(f.connection.close()).rejects.toMatchObject({
      code: "browser_cleanup_failed",
    })
    f.reply.resolve({})
    await new Promise<void>((done) => setImmediate(done))
    expect(() => f.connection.assertInputIdle()).not.toThrow()
    expect(f.interception).toEqual([])
  } finally {
    await f.clean()
  }
})
