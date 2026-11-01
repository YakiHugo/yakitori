const { app, BrowserWindow } = require("electron")
const { writeFileSync, renameSync } = require("node:fs")
const [output, page, secondOutput] = process.argv.slice(2)
const windows = []
app.whenReady().then(async () => {
  for (const destination of [output, secondOutput].filter(Boolean)) {
    const window = new BrowserWindow({
      title: "Yakitori Electron Fixture",
      width: 640,
      height: 560,
      x: destination === output ? 140 : 660,
      y: 180,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    windows.push(window)
    window.webContents.on("console-message", (details) => {
      if (!details.message.startsWith("yakitori-fixture ")) return
      const state = JSON.parse(
        details.message.slice("yakitori-fixture ".length),
      )
      writeFileSync(
        `${destination}.pending`,
        JSON.stringify({ ...state, pid: process.pid }),
      )
      renameSync(`${destination}.pending`, destination)
    })
    await window.loadFile(page)
    if (secondOutput)
      window.setTitle(
        destination === output
          ? "Yakitori Electron Fixture 1"
          : "Yakitori Electron Fixture 2",
      )
    window.show()
  }
})
app.on("window-all-closed", () => app.quit())
