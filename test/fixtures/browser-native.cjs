const assert = require("node:assert/strict")
const { once } = require("node:events")
const { mkdirSync } = require("node:fs")
const { createServer } = require("node:http")
const { pathToFileURL } = require("node:url")
const { app, BrowserWindow, WebContentsView } = require("electron")

assert(
  process.argv[3],
  "The native fixture requires an owned profile directory",
)
mkdirSync(process.argv[3], { recursive: true })
app.setPath("userData", process.argv[3])
app.setPath("sessionData", process.argv[3])

app
  .whenReady()
  .then(async () => {
    const { BrowserDocumentConnection } = await import(
      pathToFileURL(process.argv[2]).href
    )
    const keeper = new BrowserWindow({ show: false })
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<!doctype html><style>[role=button],button{display:block;width:120px;height:50px;margin:20px}#destination{margin-left:250px}</style>
<button id=button>Cold button</button><div id=source role=button tabindex=0 draggable=true aria-label=Source>Source</div><div id=destination role=button tabindex=0 aria-label=Destination>Destination</div>
<script>window.receipts=[];for(const type of ['mousemove','mousedown','mouseup','click','dblclick'])document.addEventListener(type,e=>receipts.push({type,trusted:e.isTrusted,target:e.target.id}));source.ondragstart=e=>e.dataTransfer.setData('text/plain','你好 猫 🌍');destination.ondragover=e=>e.preventDefault();destination.ondrop=e=>{e.preventDefault();receipts.push({type:'drop',trusted:e.isTrusted,text:e.dataTransfer.getData('text/plain')})};</script>`)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const origin = `http://127.0.0.1:${server.address().port}`
    const rows = []
    try {
      for (const action of ["click", "double-click", "hover", "drag"]) {
        const window = new BrowserWindow({
          show: false,
          width: 620,
          height: 520,
          webPreferences: { backgroundThrottling: false },
        })
        const view = new WebContentsView({
          webPreferences: {
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
          },
        })
        window.contentView.addChildView(view)
        view.setBounds({ x: 0, y: 0, width: 550, height: 460 })
        const contents = view.webContents,
          focus = []
        await contents.loadURL(origin)
        if (contents.isLoadingMainFrame())
          await once(contents, "did-stop-loading")
        const debug = contents.debugger,
          send = debug.sendCommand.bind(debug)
        debug.sendCommand = (method, params, sessionId) => {
          if (method === "Emulation.setFocusEmulationEnabled")
            focus.push(params.enabled)
          return send(method, params, sessionId)
        }
        const connection = new BrowserDocumentConnection(contents)
        const signal = () => new AbortController().signal
        const target = {
          tabId: "owned",
          webContentsId: contents.id,
          instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
        }
        const reference = async (name) => {
          const observed = await connection.observe(signal())
          const node = observed.nodes.find(
            (node) => node.name === name && node.elementReference,
          )
          assert(node, `Missing ${name}`)
          return node.elementReference
        }
        try {
          assert.equal(window.isVisible(), false)
          assert.equal(contents.isFocused(), false)
          assert.equal(
            await contents.executeJavaScript("document.hasFocus()"),
            false,
          )
          if (action === "drag") {
            const prepared = await connection.drag(
              {
                action: "drag_prepare",
                target,
                reference: await reference("Source"),
              },
              signal(),
            )
            const delivered = await connection.drag(
              {
                action: "drag_drop",
                target,
                dragId: prepared.dragId,
                reference: await reference("Destination"),
              },
              signal(),
            )
            assert.equal(delivered.native, true)
          } else
            await connection.inputPointer(
              {
                action: action === "double-click" ? "click" : action,
                target,
                reference: await reference("Cold button"),
                ...(action === "double-click" ? { clickCount: 2 } : {}),
              },
              signal(),
            )
          // Native input is acknowledged before this separate renderer request.
          const receipts = await contents.executeJavaScript("receipts")
          const presses = receipts.filter((event) => event.type === "mousedown")
          const releases = receipts.filter((event) => event.type === "mouseup")
          const clicks = receipts.filter((event) => event.type === "click")
          if (action === "click" || action === "double-click") {
            const count = action === "click" ? 1 : 2
            assert.equal(
              presses.length,
              count,
              JSON.stringify({ action, receipts }),
            )
            assert.equal(releases.length, count)
            assert.equal(clicks.length, count)
            assert(receipts.every((event) => event.trusted))
          } else if (action === "hover") {
            assert.equal(presses.length, 0)
            assert.equal(releases.length, 0)
            assert(
              receipts.some(
                (event) => event.type === "mousemove" && event.trusted,
              ),
            )
          } else
            assert.deepEqual(
              receipts.filter((event) => event.type === "drop"),
              [{ type: "drop", trusted: true, text: "你好 猫 🌍" }],
            )
          assert.deepEqual(focus, action === "hover" ? [] : [true, false])
          assert.equal(window.isVisible(), false)
          assert.equal(contents.isFocused(), false)
          await connection.close()
          assert.equal(debug.isAttached(), false)
          rows.push({
            action,
            trusted: true,
            osFocus: false,
            focusRestored: true,
          })
        } finally {
          // Target death is a positive completion boundary even if an assertion
          // fails while the native transport is uncertain.
          contents.close()
          window.destroy()
          await connection.close()
        }
      }
      console.log(`BROWSER_NATIVE:${JSON.stringify(rows)}`)
    } finally {
      keeper.destroy()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
