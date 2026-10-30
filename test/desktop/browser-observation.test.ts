import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"

async function observeBrowserDocument(
  contents: WebContents,
  signal: AbortSignal,
) {
  const connection = new BrowserDocumentConnection(contents)
  try {
    return await connection.observe(signal)
  } finally {
    connection.close()
  }
}

function fixture(
  options: {
    changed?: boolean
    blocked?: boolean
    nodes?: unknown[]
    devTools?: boolean
    failDetach?: boolean
  } = {},
) {
  let attached = false,
    frames = 0,
    detached = 0
  const started = Promise.withResolvers<void>(),
    events = new EventEmitter()
  const contents = {
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => options.devTools ?? false,
    getURL: () => "https://owned.test/",
    debugger: {
      on: events.on.bind(events),
      off: events.off.bind(events),
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        if (options.failDetach) throw new Error("Detach failed")
        attached = false
        detached++
        events.emit("detach", {}, "target_closed")
      },
      async sendCommand(method: string) {
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: {
                id: "main",
                loaderId:
                  options.changed && frames++ ? "replacement" : "original",
                url: "https://owned.test/",
              },
            },
          }
        if (method === "Accessibility.getFullAXTree") {
          started.resolve()
          if (options.blocked) return new Promise(() => {})
          return {
            nodes: options.nodes ?? [
              {
                nodeId: "input",
                role: { value: "textbox" },
                name: { value: "Owned field" },
                value: { value: "hello" },
                backendDOMNodeId: 31,
                properties: [{ name: "focused", value: { value: true } }],
              },
            ],
          }
        }
        throw new Error(`Unexpected CDP command: ${method}`)
      },
    },
  }
  return {
    contents: contents as unknown as WebContents,
    started: started.promise,
    detached: () => detached,
    attached: () => attached,
    takeDebugger: () => {
      events.emit("detach", {}, "replaced_with_devtools")
      attached = true
    },
    allowDetach: () => {
      options.failDetach = false
    },
  }
}

it("refuses navigation replacement before returning accessibility content", async () => {
  const f = fixture({ changed: true })
  await expect(
    observeBrowserDocument(f.contents, new AbortController().signal),
  ).rejects.toMatchObject({ code: "browser_target_changed" })
  expect(f.detached()).toBe(1)
  expect(f.attached()).toBe(false)
})

it("detaches and rejects cancellation while a read-only CDP command is pending", async () => {
  const f = fixture({ blocked: true }),
    cancellation = new AbortController()
  const observation = observeBrowserDocument(f.contents, cancellation.signal)
  await f.started
  cancellation.abort()
  await expect(observation).rejects.toMatchObject({ code: "browser_cancelled" })
  expect(f.detached()).toBe(1)
})

it("bounds large AX output and reports primitive control state and clipped text", async () => {
  const f = fixture({
    nodes: Array.from({ length: 1500 }, (_, index) => ({
      nodeId: `node_${index}`,
      role: { value: "checkbox" },
      name: { value: index === 0 ? "x".repeat(3000) : "Checked option" },
      properties: [{ name: "checked", value: { value: "true" } }],
    })),
  })
  const result = await observeBrowserDocument(
    f.contents,
    new AbortController().signal,
  )
  expect(result.truncated).toBe(true)
  expect(Array.isArray(result.nodes) && result.nodes.length <= 1000).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024)
  const nodes = result.nodes as {
    name: string
    properties: { checked: string }
  }[]
  expect(nodes[0]?.name.length).toBe(2048)
  expect(nodes[0]?.properties.checked).toBe("true")
})

it("leaves user DevTools attached instead of taking its debugger session", async () => {
  const f = fixture({ devTools: true })
  await expect(
    observeBrowserDocument(f.contents, new AbortController().signal),
  ).rejects.toMatchObject({ code: "browser_busy" })
  expect(f.detached()).toBe(0)
})

it("retains its debugger across observations and releases it explicitly", async () => {
  const f = fixture(),
    connection = new BrowserDocumentConnection(f.contents)
  try {
    await connection.observe(new AbortController().signal)
    expect(f.attached()).toBe(true)
    await connection.observe(new AbortController().signal)
    expect(f.attached()).toBe(true)
  } finally {
    connection.close()
  }
  expect(f.attached()).toBe(false)
  expect(f.detached()).toBe(1)
})

it("never detaches a debugger installed by the user after ownership was lost", async () => {
  const f = fixture(),
    connection = new BrowserDocumentConnection(f.contents)
  f.takeDebugger()
  await expect(
    connection.observe(new AbortController().signal),
  ).rejects.toMatchObject({ code: "browser_unavailable" })
  connection.close()
  expect(f.attached()).toBe(true)
  expect(f.detached()).toBe(0)
})

it("reports failed cleanup and allows a later close to confirm release", () => {
  const f = fixture({ failDetach: true }),
    connection = new BrowserDocumentConnection(f.contents)
  expect(() => connection.close()).toThrow("Detach failed")
  expect(f.attached()).toBe(true)
  f.allowDetach()
  connection.close()
  expect(f.attached()).toBe(false)
})

it("offers input references only for text controls, including when a label has the same name", async () => {
  const f = fixture({
    nodes: [
      {
        nodeId: "label",
        backendDOMNodeId: 30,
        role: { value: "StaticText" },
        name: { value: "Owned field" },
      },
      {
        nodeId: "field",
        backendDOMNodeId: 31,
        role: { value: "textbox" },
        name: { value: "Owned field" },
      },
    ],
  })
  const result = await observeBrowserDocument(
    f.contents,
    new AbortController().signal,
  )
  const nodes = result.nodes as Record<string, unknown>[]
  expect(nodes[0]).not.toHaveProperty("inputReference")
  expect(nodes[1]).toMatchObject({
    inputReference: expect.stringMatching(/^browser_node_/),
    role: "textbox",
  })
})
