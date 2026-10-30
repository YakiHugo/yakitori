import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"
import { parseBrowserObservationRequest } from "../../src/protocol/desktop-browser.ts"

const target = {
  tabId: "owned",
  webContentsId: 17,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const signal = () => new AbortController().signal

function fixture(options: { manyLocal?: number; overflow?: boolean } = {}) {
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
              backendDOMNodeId: 17,
              role: { value: "textbox" },
              name: { value: `Field ${id}` },
              value: { value: id },
            },
          ],
        }
      }
      throw new Error(`Unexpected frame command ${method}`)
    },
  }
  const connection = new BrowserDocumentConnection({
    debugger: debug,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => false,
    getURL: () => "https://owned.test/",
  } as unknown as WebContents)
  return {
    connection,
    calls,
    events,
    attached: () => attached,
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
      expect(JSON.stringify(observed.nodes)).not.toMatch(
        /inputReference|clickReference/,
      )
    }
    const main = await f.connection.observe(signal())
    expect(main.nodes).toEqual([
      expect.objectContaining({
        name: "Field main",
        inputReference: expect.any(String),
        clickReference: expect.any(String),
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
