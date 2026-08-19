const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("yakitoriDesktop", {
  openFile(input) {
    return ipcRenderer.invoke("yakitori:open-file", input)
  },
  openUrl(input) {
    return ipcRenderer.invoke("yakitori:open-url", input)
  },
})
