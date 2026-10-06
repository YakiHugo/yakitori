const { contextBridge, ipcRenderer, webUtils } = require("electron")

contextBridge.exposeInMainWorld("yakitoriDesktop", {
  platform: process.platform,
  notifications: {
    permission: () => ipcRenderer.invoke("yakitori:notification-permission"),
    show: (input) => ipcRenderer.invoke("yakitori:notification-show", input),
  },
  writeClipboardText(text) {
    return ipcRenderer.invoke("yakitori:write-clipboard-text", text)
  },
  browser: {
    create: (input) => ipcRenderer.invoke("yakitori:browser-create", input),
    navigate: (input) => ipcRenderer.invoke("yakitori:browser-navigate", input),
    action: (input) => ipcRenderer.invoke("yakitori:browser-action", input),
    viewport: (input) => ipcRenderer.invoke("yakitori:browser-viewport", input),
    selection: (input) =>
      ipcRenderer.invoke("yakitori:browser-selection", input),
    close: (input) => ipcRenderer.invoke("yakitori:browser-close", input),
    onState(listener) {
      const handler = (_event, state) => listener(state)
      ipcRenderer.on("yakitori:browser-state", handler)
      return () => ipcRenderer.removeListener("yakitori:browser-state", handler)
    },
    onShortcut(listener) {
      const handler = (_event, action) => listener(action)
      ipcRenderer.on("yakitori:browser-shortcut", handler)
      return () =>
        ipcRenderer.removeListener("yakitori:browser-shortcut", handler)
    },
    onSelection(listener) {
      const handler = (_event, selection) => listener(selection)
      ipcRenderer.on("yakitori:browser-selection", handler)
      return () =>
        ipcRenderer.removeListener("yakitori:browser-selection", handler)
    },
  },
  pickProjectFolder() {
    return ipcRenderer.invoke("yakitori:pick-project-folder")
  },
  pickAttachments() {
    return ipcRenderer.invoke("yakitori:pick-attachments")
  },
  importPickedAttachments(input) {
    return ipcRenderer.invoke("yakitori:import-picked-attachments", input)
  },
  discardPickedAttachments(input) {
    return ipcRenderer.invoke("yakitori:discard-picked-attachments", input)
  },
  async importAttachmentFiles(input) {
    const items = []
    for (const file of input.files) {
      // Match the main/sidecar transport safety boundary before allocating bytes.
      if (file.size > 50_000_000) {
        throw new Error("Attachment must be a file no larger than 50 MB.")
      }
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
    return ipcRenderer.invoke("yakitori:import-attachment-files", {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      items,
    })
  },
  discardDraftAttachments(input) {
    return ipcRenderer.invoke("yakitori:discard-draft-attachments", input)
  },
  openFile(input) {
    return ipcRenderer.invoke("yakitori:open-file", input)
  },
  openUrl(input) {
    return ipcRenderer.invoke("yakitori:open-url", input)
  },
})
