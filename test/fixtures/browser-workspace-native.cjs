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
  if (process.platform === "darwin") app.dock?.hide()
  const { registerWorkspaceBrowser } = await import(
    pathToFileURL(modulePath).href
  )
  const server = createServer((request, response) => {
    const reply = () => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        request.url === "/tab"
          ? "<style>button{display:block;width:120px;height:50px;margin:20px}</style><button onclick=\"window.open('/popup','owned')\">Open child</button><button onclick=\"window.onbeforeunload=event=>{event.preventDefault();event.returnValue=''}\">Arm unload</button>"
          : request.url === "/form"
            ? `<!doctype html><style>body{min-height:1600px}input,label{display:block}.nested{position:relative}</style>
              <h1>Owned form</h1><p>One readable paragraph.</p>
              <label>Email<input id="email" type="email"></label>
              <label>Amount<input id="number" type="number"></label>
              <label>Day<input id="date" type="date"></label>
              <div id="editable" contenteditable="true" aria-label="Notes" role="textbox">Original</div>
              <div id="custom" style="cursor:pointer" aria-label="Custom control" onclick="this.textContent='Clicked'">Click me</div>
              <div id="shadow"></div>
              <script>
                const host = document.getElementById('shadow'), outer=host.attachShadow({mode:'open'});
                const nested = outer.appendChild(document.createElement('div'));
                nested.attachShadow({mode:'open'}).innerHTML='<button onclick="window.shadowClicked=true" style="width:120px;height:40px">Nested shadow</button>';
              </script>`
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
        (item) => item.name === label && item.ref,
      )
      assert(node, `Missing browser control: ${label}`)
      await browser.request(
        { action: "click", target: first, reference: node.ref },
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
    phase = "browser form"
    await browser.request(
      {
        action: "navigate",
        target: second,
        fromUrl: `${origin}/tab`,
        url: `${origin}/form`,
      },
      other,
    )
    await window.webContents.executeJavaScript(
      "yakitoriDesktop.browser.viewport({tabId:'fixture_b',visible:true,x:0,y:0,width:550,height:460})",
    )
    const form = await browser.request(
      { action: "observe", target: second, interactiveOnly: true },
      other,
    )
    assert.match(form.outline, /\[e[0-9]+\].*Email/)
    const ref = (label, id) => {
      const control = form.nodes.find(
        (node) => (node.name === label || node.name === id) && node.ref,
      )
      assert(control, `No observed reference for ${label}\n${form.outline}`)
      return control.ref
    }
    const fields = [
      ["Email", "email", "owned@example.test"],
      ["Amount", "number", "42"],
      ["Day", "date", "2026-11-24"],
      ["Notes", "editable", "First"],
      ["Notes", "editable", "Second"],
    ]
    for (const [label, id, value] of fields) {
      const edited = await browser.request(
        {
          action: "fill",
          target: second,
          reference: ref(label, id),
          text: value,
        },
        other,
      )
      assert.equal(edited.textVerified, true)
    }
    const typed = await browser.request(
      {
        action: "type",
        target: second,
        reference: ref("Notes", "editable"),
        text: "!",
      },
      other,
    )
    assert.equal(typed.textVerified, true)
    await browser.request(
      {
        action: "click",
        target: second,
        reference: ref("Custom control", "custom"),
      },
      other,
    )
    await browser.request(
      { action: "click", target: second, reference: ref("Nested shadow") },
      other,
    )
    const contents = webContents.fromId(second.webContentsId)
    assert.deepEqual(
      await contents.executeJavaScript(`[
      document.getElementById('email').value, document.getElementById('number').value, document.getElementById('date').value,
      document.getElementById('editable').textContent, document.getElementById('custom').textContent, window.shadowClicked
    ]`),
      ["owned@example.test", "42", "2026-11-24", "Second!", "Clicked", true],
    )
    const text = await browser.request(
      { action: "text", target: second, limit: 1 },
      other,
    )
    assert.equal(text.text, "# Owned form")
    assert.equal(text.nextOffset, 1)
    const nextText = await browser.request(
      { action: "text", target: second, offset: 1, limit: 1 },
      other,
    )
    assert.equal(nextText.text, "One readable paragraph.")
    await browser.request(
      { action: "scroll", target: second, deltaX: 0, deltaY: 350 },
      other,
    )
    const deadline = performance.now() + 1200
    while (
      (await contents.executeJavaScript("window.scrollY")) === 0 &&
      performance.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert((await contents.executeJavaScript("window.scrollY")) > 0)
    await browser.finishTurn(other)
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
