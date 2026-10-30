import { EventEmitter } from "node:events"
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expect, test } from "@playwright/test"
import type { WebContents } from "electron"
import { BrowserDocumentConnection } from "../../src/desktop/browser-observation.ts"
import type { BrowserProtocolCommand } from "../../src/desktop/browser-protocol.ts"

const target = {
  tabId: "owned",
  webContentsId: 17,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const signal = () => new AbortController().signal

test("an explicitly armed document exposes its dynamically created hidden file input and uploads only to that input", async ({
  page,
  context,
}) => {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "yakitori-file-chooser-")),
    ),
    path = join(root, "chosen-你好.txt"),
    text = "Chooser 你好 🌍"
  const session = await context.newCDPSession(page),
    events = new EventEmitter(),
    send = session.send.bind(session) as BrowserProtocolCommand
  let attached = false,
    detach: Promise<void> | undefined,
    connection: BrowserDocumentConnection | undefined
  session.on("Page.fileChooserOpened", (params) =>
    events.emit("message", {}, "Page.fileChooserOpened", params),
  )
  session.on("Page.frameNavigated", (params) =>
    events.emit("message", {}, "Page.frameNavigated", params),
  )
  try {
    await writeFile(path, text)
    const metadata = await stat(path)
    await page.route("http://owned.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<button id="pick">Pick hidden</button><input id="unrelated" type="file"><script>window.fileEvents=[];pick.onclick=()=>{const input=document.createElement("input");input.type="file";input.id="hidden";input.hidden=true;input.multiple=true;for(const type of ["input","change"])input.addEventListener(type,e=>fileEvents.push({type,trusted:e.isTrusted}));document.body.append(input);input.click()};</script>',
      }),
    )
    await page.goto("http://owned.test/")
    connection = new BrowserDocumentConnection({
      isDestroyed: () => page.isClosed(),
      isLoadingMainFrame: () => false,
      isDevToolsOpened: () => false,
      getURL: () => page.url(),
      getZoomFactor: () => 1,
      debugger: {
        on: events.on.bind(events),
        off: events.off.bind(events),
        isAttached: () => attached,
        attach() {
          attached = true
        },
        detach() {
          attached = false
          events.emit("detach")
          detach = session.detach()
        },
        sendCommand(
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ) {
          if (sessionId !== undefined)
            throw new Error("Root chooser fixture crossed renderer ownership")
          return send(method, params)
        },
      },
    } as unknown as WebContents)
    expect(
      await connection.fileChooser(
        { action: "chooser_arm", target, fromUrl: page.url() },
        signal(),
      ),
    ).toMatchObject({ armed: true })
    expect(
      await connection.fileChooser(
        { action: "chooser_inspect", target },
        signal(),
      ),
    ).toMatchObject({ opened: false })
    const observed = await connection.observe(signal())
    const button = (
      observed.nodes as {
        name?: string
        role?: string
        elementReference?: string
      }[]
    ).find((node) => node.role === "button" && node.name === "Pick hidden")
    if (!button?.elementReference)
      throw new Error("Missing owned picker button")
    await connection.inputPointer(
      { action: "click", target, reference: button.elementReference },
      signal(),
    )
    const inspect = () =>
      connection?.fileChooser({ action: "chooser_inspect", target }, signal())
    await expect.poll(async () => (await inspect())?.opened).toBe(true)
    const opened = await inspect()
    expect(opened).toMatchObject({
      armed: true,
      opened: true,
      multiple: true,
      directory: false,
      fromUrl: page.url(),
    })
    if (typeof opened?.elementReference !== "string")
      throw new Error("Missing chooser input reference")
    expect(
      await connection.uploadFiles(
        {
          action: "upload",
          target,
          reference: opened.elementReference,
          fromUrl: page.url(),
          files: [
            {
              path,
              name: basename(path),
              size: metadata.size,
              lastModified: Math.trunc(metadata.mtimeMs),
            },
          ],
        },
        signal(),
      ),
    ).toMatchObject({
      filesVerified: true,
      delivered: true,
      events: "chromium",
    })
    expect(
      await page
        .locator("#hidden")
        .evaluate(async (node) =>
          (node as HTMLInputElement).files?.[0]?.text(),
        ),
    ).toBe(text)
    expect(
      await page
        .locator("#unrelated")
        .evaluate((node) => (node as HTMLInputElement).files?.length),
    ).toBe(0)
    expect(
      await page.evaluate(() => Reflect.get(globalThis, "fileEvents")),
    ).toEqual([
      { type: "input", trusted: true },
      { type: "change", trusted: true },
    ])
    expect(
      await connection.fileChooser(
        { action: "chooser_inspect", target },
        signal(),
      ),
    ).toMatchObject({ opened: false })
    expect(
      await connection.fileChooser(
        { action: "chooser_disarm", target },
        signal(),
      ),
    ).toEqual({ armed: false, interceptionDisabled: true })
    await connection.fileChooser(
      { action: "chooser_arm", target, fromUrl: page.url() },
      signal(),
    )
    await page.goto("http://owned.test/new-document")
    await expect(
      connection.fileChooser({ action: "chooser_inspect", target }, signal()),
    ).rejects.toMatchObject({ code: "browser_target_changed" })
    await connection.close()
    expect(attached).toBe(false)
  } finally {
    await connection?.close()
    if (detach) await detach
    else await session.detach()
    await rm(root, { recursive: true, force: true })
  }
})
