const { contextBridge, ipcRenderer, webUtils } = require("electron")

contextBridge.exposeInMainWorld("yakitoriDesktop", {
  pickImages(input) {
    return ipcRenderer.invoke("yakitori:pick-images", input)
  },
  async importImageFiles(input) {
    const items = []
    for (const file of input.files) {
      const filePath = webUtils.getPathForFile(file)
      items.push(
        filePath === ""
          ? {
              name: file.name,
              data: new Uint8Array(await file.arrayBuffer()),
            }
          : { name: file.name, filePath },
      )
    }
    return ipcRenderer.invoke("yakitori:import-image-files", {
      sessionId: input.sessionId,
      items,
    })
  },
  discardDraftImages(input) {
    return ipcRenderer.invoke("yakitori:discard-draft-images", input)
  },
  openFile(input) {
    return ipcRenderer.invoke("yakitori:open-file", input)
  },
  openUrl(input) {
    return ipcRenderer.invoke("yakitori:open-url", input)
  },
})
