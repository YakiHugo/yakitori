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

test("a prearmed native dialog reply unblocks trusted input and confirms its ACK before button release", async ({
  page,
  context,
}) => {
  await page.route("http://owned.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<button id="ask">Confirm</button><button id="notify">Alert</button><button id="leave">Leave</button><button id="askText">Prompt</button><script>window.receipts=[];window.originalPrompt=window.prompt;askText.onclick=e=>receipts.push({trusted:e.isTrusted,value:window.prompt("Owned prompt","default")});ask.onclick=e=>receipts.push({trusted:e.isTrusted,value:window.confirm("Continue?")});notify.onclick=e=>{window.alert("Attention");receipts.push({trusted:e.isTrusted,value:"alert done"})};leave.onclick=()=>location.href="/next";</script>',
    }),
  )
  await page.goto("http://owned.test/")
  // Playwright's automatic dismissal would bypass the production responder.
  page.on("dialog", () => {})
  const session = await context.newCDPSession(page),
    events = new EventEmitter(),
    send = session.send.bind(session) as BrowserProtocolCommand,
    answering = Promise.withResolvers<void>(),
    acknowledgement = Promise.withResolvers<void>(),
    inputs: string[] = []
  for (const method of [
    "Page.javascriptDialogOpening",
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
  ] as const)
    session.on(method, (params) =>
      events.emit("message", {}, method, params, ""),
    )
  let attached = false,
    detach: Promise<void> | undefined,
    delayReply = true
  let input: Promise<unknown> | undefined
  const connection = new BrowserDocumentConnection({
    isDestroyed: () => page.isClosed(),
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => false,
    getURL: () => page.url(),
    getZoomFactor: () => 1,
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
      async sendCommand(
        method: string,
        params: Record<string, unknown>,
        sessionId?: string,
      ) {
        if (sessionId !== undefined)
          throw new Error("Root dialog crossed renderer ownership")
        if (method === "Input.dispatchKeyEvent")
          inputs.push(String(params.type))
        const result = await send(method, params)
        if (method === "Page.handleJavaScriptDialog" && delayReply) {
          answering.resolve()
          await acknowledgement.promise
        }
        return result
      },
    },
  } as unknown as WebContents)
  try {
    for (const [type, accept] of [
      ["confirm", false],
      ["confirm", true],
      ["alert", true],
      ["prompt", true],
      ["prompt", false],
      ["beforeunload", false],
    ] as const) {
      if (type === "beforeunload")
        await page.evaluate(() => {
          window.onbeforeunload = (event) => {
            event.preventDefault()
            event.returnValue = ""
          }
        })
      const observed = await connection.observe(signal()),
        button = (
          observed.nodes as { name?: string; elementReference?: string }[]
        ).find(
          (node) =>
            node.name ===
            (type === "prompt"
              ? "Prompt"
              : type === "beforeunload"
                ? "Leave"
                : type === "confirm"
                  ? "Confirm"
                  : "Alert"),
        )
      if (!button?.elementReference)
        throw new Error("Missing observed dialog trigger")
      await connection.dialog(
        {
          action: "dialog_arm",
          target,
          fromUrl: page.url(),
          response: {
            type,
            accept,
            ...(type === "prompt" && accept
              ? { promptText: "你好 猫 🌍" }
              : {}),
            ...(type === "beforeunload"
              ? {}
              : {
                  message:
                    type === "confirm"
                      ? "Continue?"
                      : type === "prompt"
                        ? "Owned prompt"
                        : "Attention",
                }),
          },
        },
        signal(),
      )
      const click = connection.pressKey(
        {
          action: "press",
          key: "Enter",
          target,
          reference: button.elementReference,
        },
        signal(),
      )
      input = click
      if (delayReply) {
        await answering.promise
        expect(inputs).toEqual(["keyDown"])
        acknowledgement.resolve()
        delayReply = false
      }
      await click
      expect(
        await connection.dialog({ action: "dialog_inspect", target }, signal()),
      ).toMatchObject({ state: "answered", expired: false })
      await connection.dialog({ action: "dialog_disarm", target }, signal())
      expect(
        await page.evaluate(
          () => Reflect.get(globalThis, "originalPrompt") === window.prompt,
        ),
      ).toBe(true)
    }
    expect(
      await page.evaluate(() => Reflect.get(globalThis, "receipts")),
    ).toEqual([
      { trusted: true, value: false },
      { trusted: true, value: true },
      { trusted: true, value: "alert done" },
      { trusted: true, value: "你好 猫 🌍" },
      { trusted: true, value: null },
    ])
    expect(page.url()).toBe("http://owned.test/")
    await page.evaluate(() => {
      window.onbeforeunload = null
    })
  } finally {
    acknowledgement.resolve()
    await Promise.allSettled(input ? [input] : [])
    await connection.close()
    if (detach) await detach
    else await session.detach()
  }
})

for (const change of ["hash", "replacement", "navigation"] as const) {
  test(`native prompt cleanup respects ${change} under strict CSP`, async ({
    page,
    context,
  }) => {
    const { BrowserDialogs } = await import(
      "../../src/desktop/browser-dialogs.ts"
    )
    await page.route("http://prompt.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: {
          "content-security-policy":
            "default-src 'none'; frame-src 'none'; script-src 'none'",
        },
        body: "<title>Owned CSP prompt</title>",
      }),
    )
    await page.goto("http://prompt.test/")
    page.on("dialog", () => {})
    const session = await context.newCDPSession(page),
      events = new EventEmitter(),
      send = session.send.bind(session) as BrowserProtocolCommand,
      dialogs = new BrowserDialogs({
        on: events.on.bind(events),
        off: events.off.bind(events),
      } as unknown as WebContents["debugger"])
    for (const method of [
      "Page.javascriptDialogOpening",
      "Page.frameNavigated",
      "Page.navigatedWithinDocument",
      "Runtime.executionContextCreated",
      "Runtime.executionContextDestroyed",
      "Runtime.executionContextsCleared",
    ] as const)
      session.on(method, (params) =>
        events.emit("message", {}, method, params, ""),
      )
    const frame = (await session.send("Page.getFrameTree")).frameTree.frame
    try {
      await page.evaluate(() => {
        Reflect.set(globalThis, "originalPrompt", window.prompt)
      })
      await dialogs.arm(
        {
          document: {
            frameId: frame.id,
            documentId: frame.loaderId,
            url: frame.url,
          },
          closed: signal(),
        },
        {
          type: "prompt",
          accept: true,
          message: "CSP native",
          ...(change === "hash" ? {} : { promptText: "原生文本 🌍" }),
        },
        async (method, params, sessionId, confirmed) => {
          if (sessionId !== undefined)
            throw new Error("CSP prompt crossed renderer ownership")
          const result = await send(method, params)
          confirmed?.(result)
          return result
        },
      )
      expect(
        (
          await session.send("Runtime.evaluate", {
            expression: 'prompt("CSP native","default")',
            userGesture: true,
            returnByValue: true,
          })
        ).result.value,
      ).toBe(change === "hash" ? "" : "原生文本 🌍")
      if (change === "hash")
        await page.evaluate(() => {
          location.hash = "changed"
        })
      else if (change === "replacement")
        await page.evaluate(() => {
          window.prompt = () => "page replacement"
        })
      else await page.goto("http://prompt.test/next")
      await dialogs.disarm()
      expect(await page.locator("iframe").count()).toBe(0)
      if (change === "replacement")
        expect(await page.evaluate(() => window.prompt())).toBe(
          "page replacement",
        )
      else if (change === "hash")
        expect(
          await page.evaluate(
            () => window.prompt === Reflect.get(globalThis, "originalPrompt"),
          ),
        ).toBe(true)
      else
        expect(
          await page.evaluate(() =>
            Function.prototype.toString.call(window.prompt),
          ),
        ).toContain("[native code]")
    } finally {
      await dialogs.disarm()
      dialogs.close()
      await session.detach()
    }
  })
}
