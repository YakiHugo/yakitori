import { EventEmitter } from "node:events"
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { WebContents } from "electron"
import type { BrowserProtocolCommand } from "../../src/desktop/browser-frames.ts"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"

// The production connection talks to real Chromium, including asynchronous native
// filesystem enumeration. The small adapter substitutes only Electron's transport.
test("directory selection waits for native enumeration and verifies nested relative paths and bytes", async ({
  page,
  context,
}) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-directory-browser-")),
  )
  const folder = join(directory, "folder-你好")
  const session = await context.newCDPSession(page)
  const send = session.send.bind(session) as BrowserProtocolCommand
  const events = new EventEmitter()
  let attached = false,
    detach: Promise<void> | undefined
  let connection: BrowserDocumentConnection | undefined
  try {
    await mkdir(join(folder, "nested/empty"), { recursive: true })
    for (const [name, text] of [
      ["a.txt", "one"],
      [".hidden", "你好"],
      ["nested/b.txt", "four"],
    ]) {
      if (!name || !text) throw new Error("Invalid fixture")
      await writeFile(join(folder, name), text)
      await utimes(join(folder, name), 1700000000, 1700000000)
    }
    await page.route("http://owned.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<label>Folder<input id="folder" type="file" webkitdirectory></label><script>window.fileEvents=[];for(const type of ["input","change","cancel"])folder.addEventListener(type,e=>fileEvents.push({type,trusted:e.isTrusted,count:folder.files.length}));</script>',
      }),
    )
    await page.goto("http://owned.test/")
    connection = new BrowserDocumentConnection({
      isDestroyed: () => page.isClosed(),
      isLoadingMainFrame: () => false,
      isDevToolsOpened: () => false,
      getURL: () => page.url(),
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
          detach = session.detach()
        },
        sendCommand: (
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ) => {
          if (sessionId !== undefined)
            throw new Error("Root-only fixture crossed session ownership")
          return send(method, params)
        },
      },
    } as unknown as WebContents)
    const expected = [
      {
        name: "a.txt",
        size: 3,
        lastModified: 1700000000000,
        relativePath: "folder-你好/a.txt",
      },
      {
        name: ".hidden",
        size: 6,
        lastModified: 1700000000000,
        relativePath: "folder-你好/.hidden",
      },
      {
        name: "b.txt",
        size: 4,
        lastModified: 1700000000000,
        relativePath: "folder-你好/nested/b.txt",
      },
    ]
    for (let attempt = 0; attempt < 2; attempt++) {
      const observed = await connection.observe(new AbortController().signal)
      const node = (
        observed.nodes as {
          role?: string
          name?: string
          elementReference?: string
        }[]
      ).find((node) => node.role === "button" && node.name === "Folder")
      if (!node?.elementReference)
        throw new Error("Missing exact directory input")
      const receipt = await connection.uploadFiles(
        {
          action: "upload_directory",
          target: {
            tabId: "owned",
            webContentsId: 17,
            instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
          },
          reference: node.elementReference,
          fromUrl: page.url(),
          directory: folder,
          files: expected,
        },
        new AbortController().signal,
      )
      expect(receipt).toMatchObject({
        delivered: true,
        action: "upload_directory",
        filesVerified: true,
        cleared: false,
        events: "chromium",
        files: expect.arrayContaining(expected),
      })
      expect(receipt.files).toHaveLength(3)
    }
    expect(
      await page.locator("input").evaluate(async (input) =>
        Promise.all(
          Array.from((input as HTMLInputElement).files ?? [], async (file) => ({
            path: file.webkitRelativePath,
            text: await file.text(),
          })),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        { path: "folder-你好/a.txt", text: "one" },
        { path: "folder-你好/.hidden", text: "你好" },
        { path: "folder-你好/nested/b.txt", text: "four" },
      ]),
    )
    expect(
      await page.evaluate(() => Reflect.get(globalThis, "fileEvents")),
    ).toEqual([
      { type: "input", trusted: true, count: 3 },
      { type: "change", trusted: true, count: 3 },
      { type: "input", trusted: true, count: 3 },
      { type: "change", trusted: true, count: 3 },
    ])
    const emptyFolder = join(directory, "empty")
    await mkdir(emptyFolder)
    const observed = await connection.observe(new AbortController().signal)
    const emptyNode = (
      observed.nodes as {
        role?: string
        name?: string
        elementReference?: string
      }[]
    ).find((node) => node.role === "button" && node.name === "Folder")
    if (!emptyNode?.elementReference)
      throw new Error("Missing directory input for empty selection")
    expect(
      await connection.uploadFiles(
        {
          action: "upload_directory",
          target: {
            tabId: "owned",
            webContentsId: 17,
            instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
          },
          reference: emptyNode.elementReference,
          fromUrl: page.url(),
          directory: emptyFolder,
          files: [],
        },
        new AbortController().signal,
      ),
    ).toMatchObject({
      filesVerified: true,
      files: [],
      cleared: false,
      events: "chromium",
    })
  } finally {
    await connection?.close()
    if (detach) await detach
    else await session.detach()
    await rm(directory, { recursive: true, force: true })
  }
})
