const assert = require("node:assert/strict")
const { once } = require("node:events")
const { mkdirSync } = require("node:fs")
const { createServer } = require("node:http")
const { pathToFileURL } = require("node:url")
const { app, BrowserWindow, webContents } = require("electron")

const [, , modulePath, profile, preload] = process.argv
mkdirSync(profile, { recursive: true })
app.setPath("userData", profile)
app.setPath("sessionData", profile)
let phase = "startup"
const watchdog = setTimeout(() => {
  console.error(`Browser workspace fixture stalled: ${phase}`)
  app.exit(2)
}, 30_000)
watchdog.unref()
process.on("uncaughtException", (error) => {
  console.error(error)
  app.exit(1)
})

async function main() {
  await app.whenReady()
  const { registerWorkspaceBrowser } = await import(
    pathToFileURL(modulePath).href
  )
  const server = createServer((request, response) => {
    const reply = () => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        request.url === "/tab"
          ? "<style>button{display:block;width:120px;height:50px;margin:20px}</style><button onclick=\"window.open('/popup','owned')\">Open child</button><button onclick=\"window.onbeforeunload=event=>{event.preventDefault();event.returnValue=''}\">Arm unload</button>"
          : `<title>${request.url}</title><p>Owned fixture</p>`,
      )
    }
    if (request.url === "/slow") setTimeout(reply, 13_000)
    else reply()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  const window = new BrowserWindow({ show: false, webPreferences: { preload } })
  await window.loadURL(`${origin}/ui`)
  const browser = registerWorkspaceBrowser(window)
  const owner = { sessionId: "fixture_a", turnId: "turn_a" }
  const other = { sessionId: "fixture_b", turnId: "turn_b" }
  const list = async () =>
    (await browser.request({ action: "list" }, owner)).tabs

  try {
    for (const tabId of ["fixture_a", "fixture_b"]) {
      await window.webContents.executeJavaScript(
        `yakitoriDesktop.browser.create(${JSON.stringify({ tabId, url: `${origin}/tab` })})`,
      )
    }
    const first = (await list()).find(
      (row) => row.target.tabId === "fixture_a",
    ).target
    const second = (await list()).find(
      (row) => row.target.tabId === "fixture_b",
    ).target
    for (const target of [first, second]) {
      const contents = webContents.fromId(target.webContentsId)
      if (contents.isLoadingMainFrame())
        await once(contents, "did-stop-loading")
    }
    await window.webContents.executeJavaScript(
      "yakitoriDesktop.browser.viewport({tabId:'fixture_a',visible:true,x:0,y:0,width:550,height:460})",
    )
    const click = async (label) => {
      const observed = await browser.request(
        { action: "observe", target: first },
        owner,
      )
      const node = observed.nodes.find(
        (item) => item.name === label && item.elementReference,
      )
      assert(node, `Missing browser control: ${label}`)
      await browser.request(
        { action: "click", target: first, reference: node.elementReference },
        owner,
      )
    }

    phase = "open popup"
    await click("Open child")
    const popup = (await list()).find((row) =>
      row.target.tabId.startsWith("popup_"),
    ).target
    phase = "popup load"
    const popupContents = webContents.fromId(popup.webContentsId)
    if (popupContents.isLoadingMainFrame())
      await once(popupContents, "did-stop-loading")
    assert.equal(popupContents.getURL(), `${origin}/popup`)
    assert.equal(
      await popupContents.executeJavaScript("window.opener?.location.pathname"),
      "/tab",
    )
    assert.equal(
      webContents.fromId(first.webContentsId).getURL(),
      `${origin}/tab`,
    )
    assert.equal(
      (
        await browser.request(
          { action: "close", target: popup, fromUrl: `${origin}/popup` },
          owner,
        )
      ).closed,
      true,
    )
    assert(!(await list()).some((row) => row.target.tabId === popup.tabId))

    phase = "arm beforeunload"
    await click("Arm unload")
    await browser.request(
      {
        action: "dialog_arm",
        target: first,
        fromUrl: `${origin}/tab`,
        response: { type: "beforeunload", accept: false },
      },
      owner,
    )
    await assert.rejects(
      browser.request(
        {
          action: "navigate",
          target: first,
          fromUrl: `${origin}/tab`,
          url: `${origin}/blocked`,
        },
        owner,
      ),
      { code: "browser_navigation_unconfirmed" },
    )
    assert.equal(
      webContents.fromId(first.webContentsId).getURL(),
      `${origin}/tab`,
    )
    await browser.request({ action: "dialog_disarm", target: first }, owner)
    const armed = await browser.request(
      {
        action: "dialog_arm",
        target: first,
        fromUrl: `${origin}/tab`,
        response: { type: "beforeunload", accept: true },
      },
      owner,
    )
    assert.equal(armed.armed, true)
    phase = "slow navigation"
    const started = performance.now()
    const navigation = browser.request(
      {
        action: "navigate",
        target: first,
        fromUrl: `${origin}/tab`,
        url: `${origin}/slow`,
      },
      owner,
    )
    void navigation.catch(() => {})
    const observation = await browser.request(
      { action: "observe", target: second },
      other,
    )
    assert(observation.nodes.length > 0)
    assert(
      performance.now() - started < 12_000,
      "Another tab waited for the first navigation",
    )
    assert.equal((await navigation).url, `${origin}/slow`)
    assert(performance.now() - started > 12_000)
    phase = "inspect beforeunload"
    const handled = await browser.request(
      { action: "dialog_inspect", target: first },
      owner,
    )
    assert.equal(handled.state, "answered")
    assert.equal(handled.dialog.type, "beforeunload")
    phase = "release"
    await Promise.all([browser.finishTurn(owner), browser.finishTurn(other)])
    console.log("BROWSER_WORKSPACE:passed")
  } finally {
    window.destroy()
    server.close()
  }
}

main().then(
  () => app.exit(0),
  (error) => {
    console.error(error)
    app.exit(1)
  },
)
