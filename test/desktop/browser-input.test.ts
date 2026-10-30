import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"
import {
  type BrowserInputRequest,
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
  } = {},
) {
  const events = new EventEmitter(),
    insertion = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let attached = false,
    documentId = "original",
    value = "first",
    inputCalls = 0,
    focused = false
  const contents = {
    isDestroyed: () => false,
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
                role: { value: "textbox" },
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
        if (method === "Runtime.callFunctionOn")
          return {
            result: {
              value: {
                ok: focused && !options.redirectFocus,
                value,
                start: value.length,
                end: value.length,
              },
            },
          }
        if (method === "Input.insertText") {
          inputCalls++
          insertion.resolve()
          if (options.blockInput) await release.promise
          if (!options.wrongReceipt) value += params.text
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
    inputCalls: () => inputCalls,
    value: () => value,
    navigate: () => {
      documentId = "replacement"
    },
    async request(text = "你好 🌍"): Promise<BrowserInputRequest> {
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
      await f.connection.typeText(input, new AbortController().signal),
    ).toMatchObject({ delivered: true, textVerified: true })
    expect(f.value()).toBe("first你好 🌍")
    await expect(
      f.connection.typeText(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_reference_stale" })
    expect(f.inputCalls()).toBe(1)
  } finally {
    f.connection.close()
  }
})

it("invalidates older references when a new observation is requested", async () => {
  const f = fixture()
  try {
    const old = await f.request()
    await f.request()
    await expect(
      f.connection.typeText(old, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_reference_stale" })
    expect(f.inputCalls()).toBe(0)
  } finally {
    f.connection.close()
  }
})

it("refuses replacement documents and redirected focus before inserting any text", async () => {
  for (const redirected of [false, true]) {
    const f = fixture({ redirectFocus: redirected })
    try {
      const input = await f.request()
      if (!redirected) f.navigate()
      await expect(
        f.connection.typeText(input, new AbortController().signal),
      ).rejects.toMatchObject({
        code: redirected
          ? "browser_input_unavailable"
          : "browser_target_changed",
      })
      expect(f.inputCalls()).toBe(0)
    } finally {
      f.connection.close()
    }
  }
})

it("reports an unconfirmed receipt without repeating a text insertion", async () => {
  const f = fixture({ wrongReceipt: true })
  try {
    const input = await f.request()
    await expect(
      f.connection.typeText(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "browser_input_unconfirmed" })
    expect(f.inputCalls()).toBe(1)
  } finally {
    f.connection.close()
  }
})

it("does not abandon an in-flight text dispatch when cancellation arrives", async () => {
  const f = fixture({ blockInput: true }),
    cancellation = new AbortController()
  try {
    const input = await f.request()
    let settled = false
    const pending = f.connection
      .typeText(input, cancellation.signal)
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
    f.connection.close()
  }
})
