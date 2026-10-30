import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"
import {
  browserRequestMutates,
  parseBrowserRequest,
} from "../../src/protocol/desktop-browser.ts"

const target = {
  tabId: "owned",
  webContentsId: 1,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const request = {
  action: "select",
  target,
  reference: "browser_element_00000000-0000-4000-8000-000000000001",
  options: [{ value: "你好" }, { label: "Green" }, { index: 2 }],
}

it("admits native option descriptors as mutating browser input and rejects mixed, raw or oversized requests", () => {
  const parsed = parseBrowserRequest(request)
  expect(parsed).toEqual(request)
  expect(browserRequestMutates(parsed)).toBe(true)
  expect(parseBrowserRequest({ ...request, options: [] })).toMatchObject({
    action: "select",
    options: [],
  })
  for (const override of [
    { reference: "browser_node_00000000-0000-4000-8000-000000000001" },
    { sessionId: "foreign" },
    { text: "wrong action" },
    { options: ["g"] },
    { options: [{ value: "g", label: "Green" }] },
    { options: [{ index: -1 }] },
    { options: [{ index: 1.5 }] },
    { options: [{ index: Number.MAX_SAFE_INTEGER + 1 }] },
    { options: [{ other: "g" }] },
    { options: Array.from({ length: 257 }, () => ({ value: "x" })) },
    { options: [{ value: "x".repeat(65536) }] },
  ])
    expect(() => parseBrowserRequest({ ...request, ...override })).toThrow()
})

it.each([
  true,
  false,
])("confirms selected values after a separate protocol read without replaying the mutation (confirmed: %s)", async (confirmed) => {
  const events = new EventEmitter()
  let attached = false,
    mutations = 0,
    groupsReleased = 0
  const connection = new BrowserDocumentConnection({
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    isLoadingMainFrame: () => false,
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
        events.emit("detach")
      },
      async sendCommand(method: string, params: Record<string, unknown> = {}) {
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: { id: "main", loaderId: "v1", url: "https://owned.test/" },
            },
          }
        if (method === "Accessibility.getFullAXTree")
          return {
            nodes: [
              {
                nodeId: "select",
                backendDOMNodeId: 31,
                role: { value: "combobox" },
                name: { value: "Choices" },
              },
            ],
          }
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: 71 }
        if (method === "DOM.resolveNode")
          return { object: { objectId: "exact_select" } }
        if (method === "DOM.focus") return {}
        if (method === "Runtime.callFunctionOn") {
          const args = params.arguments as { value: unknown }[]
          const values = args[0]?.value
          if (Array.isArray(values) && typeof values[0] === "object") {
            mutations++
            return {
              result: { value: { ok: true, applied: true, values: ["g"] } },
            }
          }
          return { result: { value: confirmed } }
        }
        if (method === "Runtime.releaseObjectGroup") {
          groupsReleased++
          return {}
        }
        throw new Error(`Unexpected select command ${method}`)
      },
    },
  } as unknown as WebContents)
  try {
    const observed = await connection.observe(new AbortController().signal)
    const node = (observed.nodes as { elementReference?: string }[])[0]
    if (!node?.elementReference) throw new Error("Missing observed select")
    const pending = connection.selectOptions(
      {
        action: "select",
        target,
        reference: node.elementReference,
        options: [{ value: "g" }],
      },
      new AbortController().signal,
    )
    if (confirmed)
      expect(await pending).toMatchObject({
        delivered: true,
        selectionVerified: true,
        values: ["g"],
        events: "synthetic",
      })
    else
      await expect(pending).rejects.toMatchObject({
        code: "browser_input_unconfirmed",
      })
    expect(mutations).toBe(1)
    expect(groupsReleased).toBe(1)
  } finally {
    await connection.close()
  }
})
