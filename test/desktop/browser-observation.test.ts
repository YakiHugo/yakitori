import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { observeBrowserDocument } from "../../src/desktop/browser-observation.ts"

function fixture(
  options: {
    changed?: boolean
    blocked?: boolean
    nodes?: unknown[]
    devTools?: boolean
  } = {},
) {
  let attached = false,
    frames = 0,
    detached = 0
  const started = Promise.withResolvers<void>()
  const contents = {
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => options.devTools ?? false,
    getURL: () => "https://owned.test/",
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
        detached++
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
