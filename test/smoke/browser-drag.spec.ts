import { EventEmitter } from "node:events"
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

test("trusted HTML5 and mouse drags use observed endpoints and leave no held input", async ({
  page,
  context,
}) => {
  await page.route("http://owned.test/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<style>[role=button],button {display:block;width:120px;height:50px;margin:20px} #destination{margin-left:250px}</style>
      <div role="button" aria-label="Native source" id="source" draggable="true" tabindex="0">Source</div>
      <button id="mouse">Mouse source</button>
      <div role="button" aria-label="Destination" id="destination" tabindex="0">Destination</div>
      <button id="after">After drag</button>
      <script>
      window.receipts=[];window.dragging=false;
      source.ondragstart=e=>{e.dataTransfer.setData('text/plain','你好 猫 🌍');receipts.push({type:'start',trusted:e.isTrusted})};
      destination.ondragover=e=>e.preventDefault();
      destination.ondrop=e=>{e.preventDefault();receipts.push({type:'drop',trusted:e.isTrusted,text:e.dataTransfer.getData('text/plain')})};
      destination.onclick=e=>receipts.push({type:'unexpected-click',trusted:e.isTrusted});
      mouse.onmousedown=e=>{dragging=true;receipts.push({type:'down',trusted:e.isTrusted})};
      document.onmouseup=e=>{if(dragging){dragging=false;receipts.push({type:'up',trusted:e.isTrusted,target:e.target.id})}};
      after.onclick=e=>receipts.push({type:'after',trusted:e.isTrusted});
      </script>`,
    }),
  )
  await page.setViewportSize({ width: 282, height: 700 })
  await page.goto("http://owned.test/")
  const session = await context.newCDPSession(page),
    events = new EventEmitter(),
    send = session.send.bind(session) as BrowserProtocolCommand
  for (const method of [
    "Input.dragIntercepted",
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Page.frameNavigated",
  ] as const)
    session.on(method, (params) =>
      events.emit("message", {}, method, params, ""),
    )
  let attached = false,
    detach: Promise<void> | undefined
  const connection = new BrowserDocumentConnection({
    isDestroyed: () => page.isClosed(),
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => false,
    getURL: () => page.url(),
    getZoomFactor: () => 1,
    capturePage: () =>
      page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }),
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
      sendCommand: send,
    },
  } as unknown as WebContents)
  const reference = async (name: string) => {
    const observed = await connection.observe(signal())
    const node = (
      observed.nodes as { name?: string; elementReference?: string }[]
    ).find((node) => node.name === name)
    if (!node?.elementReference) throw new Error(`Missing observed ${name}`)
    return node.elementReference
  }
  try {
    for (const [name, native] of [
      ["Native source", true],
      ["Mouse source", false],
    ] as const) {
      const prepared = await connection.drag(
        { action: "drag_prepare", target, reference: await reference(name) },
        signal(),
      )
      if (typeof prepared.dragId !== "string")
        throw new Error("Missing drag source token")
      const drop = {
        action: "drag_drop" as const,
        target,
        dragId: prepared.dragId,
        reference: await reference("Destination"),
      }
      expect(await connection.drag(drop, signal())).toMatchObject({
        delivered: true,
        native,
        documentChanged: false,
      })
      await expect(connection.drag(drop, signal())).rejects.toMatchObject({
        code: "browser_reference_stale",
      })
      connection.assertInputIdle()
    }
    await connection.inputPointer(
      { action: "click", target, reference: await reference("After drag") },
      signal(),
    )
    expect(
      await page.evaluate(() => Reflect.get(globalThis, "receipts")),
    ).toEqual([
      { type: "start", trusted: true },
      { type: "drop", trusted: true, text: "你好 猫 🌍" },
      { type: "down", trusted: true },
      { type: "up", trusted: true, target: "destination" },
      { type: "after", trusted: true },
    ])

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.evaluate(() => {
      document.body.innerHTML =
        '<iframe name="source" src="/source" style="width:450px;height:600px"></iframe><iframe name="destination" src="/destination" style="width:450px;height:600px"></iframe>'
    })
    await expect(
      page
        .frameLocator('iframe[name="source"]')
        .getByRole("button", { name: "Native source" }),
    ).toBeVisible()
    await expect(
      page
        .frameLocator('iframe[name="destination"]')
        .getByRole("button", { name: "Destination", exact: true }),
    ).toBeVisible()
    const catalog = await connection.frames(0, signal()),
      frames = catalog.frames as { name: string; frameReference: string }[]
    const frameReference = async (name: string, control: string) => {
      const frame = frames.find((frame) => frame.name === name)
      if (!frame) throw new Error(`Missing ${name} frame`)
      const observed = await connection.observe(signal(), frame.frameReference)
      const node = (
        observed.nodes as { name?: string; elementReference?: string }[]
      ).find((node) => node.name === control)
      if (!node?.elementReference)
        throw new Error(`Missing observed frame control ${control}`)
      return node.elementReference
    }
    const prepared = await connection.drag(
      {
        action: "drag_prepare",
        target,
        reference: await frameReference("source", "Native source"),
      },
      signal(),
    )
    if (typeof prepared.dragId !== "string")
      throw new Error("Missing framed source token")
    expect(
      await connection.drag(
        {
          action: "drag_drop",
          target,
          dragId: prepared.dragId,
          reference: await frameReference("destination", "Destination"),
        },
        signal(),
      ),
    ).toMatchObject({ native: true, delivered: true, documentChanged: false })
    expect(
      await page
        .frame({ name: "source" })
        ?.evaluate(() => Reflect.get(globalThis, "receipts")),
    ).toEqual([{ type: "start", trusted: true }])
    expect(
      await page
        .frame({ name: "destination" })
        ?.evaluate(() => Reflect.get(globalThis, "receipts")),
    ).toEqual([{ type: "drop", trusted: true, text: "你好 猫 🌍" }])
    connection.assertInputIdle()
  } finally {
    await connection.close()
    if (detach) await detach
  }
})
