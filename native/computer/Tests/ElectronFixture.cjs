const { app, BrowserWindow } = require("electron")
const { writeFileSync, renameSync } = require("node:fs")
const [output, page] = process.argv.slice(2)
let window
app.whenReady().then(async () => {
  window = new BrowserWindow({
    title: "Yakitori Electron Fixture",
    width: 640,
    height: 560,
    x: 140,
    y: 180,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.webContents.on("console-message", (details) => {
    if (!details.message.startsWith("yakitori-fixture ")) return
    const state = JSON.parse(details.message.slice("yakitori-fixture ".length))
    writeFileSync(
      `${output}.pending`,
      JSON.stringify({ ...state, pid: process.pid }),
    )
    renameSync(`${output}.pending`, output)
  })
  await window.loadFile(page)
  window.show()
})
app.on("window-all-closed", () => app.quit())
