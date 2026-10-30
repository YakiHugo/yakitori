import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"

const target = {
  tabId: "owned",
  webContentsId: 1,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const file = {
  path: "/file.txt",
  name: "file.txt",
  size: 5,
  lastModified: 1000,
}

function fixture(mismatch = false) {
  const events = new EventEmitter(),
    mutations: string[][] = []
  let attached = false,
    actual = [{ name: "old.txt", size: 1, lastModified: 0, relativePath: "" }],
    clears = 0
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
                nodeId: "files",
                backendDOMNodeId: 31,
                role: { value: "button" },
                name: { value: "Files" },
              },
            ],
          }
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: 71 }
        if (method === "DOM.resolveNode")
          return { object: { objectId: "exact_files" } }
        if (method === "DOM.setFileInputFiles") {
          const paths = params.files as string[]
          mutations.push(paths)
          // Empty CDP selection acknowledges but leaves the files unchanged,
          // matching the owned Electron probe rather than the clear helper.
          if (paths.length)
            actual = [
              {
                name: mismatch ? "changed.txt" : "file.txt",
                size: 5,
                lastModified: 1000,
                relativePath: "",
              },
            ]
          return {}
        }
        if (method === "Runtime.callFunctionOn") {
          if (!params.arguments) {
            actual = []
            clears++
            return { result: { value: { ok: true, applied: true } } }
          }
          const args = params.arguments as { value: boolean }[]
          return {
            result: {
              value: args[0]?.value
                ? { ok: true, files: actual }
                : { ok: true, multiple: true, directory: false },
            },
          }
        }
        if (method === "Runtime.releaseObjectGroup") return {}
        throw new Error(`Unexpected file command ${method}`)
      },
    },
  } as unknown as WebContents)
  return {
    connection,
    mutations,
    clears: () => clears,
    async reference() {
      const observed = await connection.observe(new AbortController().signal),
        node = (observed.nodes as { elementReference?: string }[])[0]
      if (!node?.elementReference) throw new Error("Missing file reference")
      return node.elementReference
    },
  }
}

it.each([
  false,
  true,
])("verifies native file metadata and never replays an uncertain file selection (mismatch: %s)", async (mismatch) => {
  const f = fixture(mismatch)
  try {
    const pending = f.connection.uploadFiles(
      {
        action: "upload",
        target,
        reference: await f.reference(),
        fromUrl: "https://owned.test/",
        files: [file],
      },
      new AbortController().signal,
    )
    if (mismatch)
      await expect(pending).rejects.toMatchObject({
        code: "browser_input_unconfirmed",
      })
    else
      expect(await pending).toMatchObject({
        delivered: true,
        filesVerified: true,
        files: [{ name: "file.txt", size: 5, lastModified: 1000 }],
        cleared: false,
        events: "chromium",
      })
    expect(f.mutations).toEqual([["/file.txt"]])
    expect(f.clears()).toBe(0)
  } finally {
    await f.connection.close()
  }
})

it("clears existing files explicitly even when an empty CDP file list would be a no-op", async () => {
  const f = fixture()
  try {
    expect(
      await f.connection.uploadFiles(
        {
          action: "upload",
          target,
          reference: await f.reference(),
          fromUrl: "https://owned.test/",
          files: [],
        },
        new AbortController().signal,
      ),
    ).toMatchObject({
      delivered: true,
      filesVerified: true,
      files: [],
      cleared: true,
      events: "synthetic",
    })
    expect(f.clears()).toBe(1)
  } finally {
    await f.connection.close()
  }
})

it("refuses a disclosure URL that differs from the captured document before exposing file paths to Chromium", async () => {
  const f = fixture()
  try {
    await expect(
      f.connection.uploadFiles(
        {
          action: "upload",
          target,
          reference: await f.reference(),
          fromUrl: "https://other.test/",
          files: [file],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "browser_target_changed" })
    expect(f.mutations).toEqual([])
  } finally {
    await f.connection.close()
  }
})
