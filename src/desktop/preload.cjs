const { contextBridge, ipcRenderer, webUtils } = require("electron")

contextBridge.exposeInMainWorld("yakitoriDesktop", {
  platform: process.platform,
  focusWindow() {
    return ipcRenderer.invoke("yakitori:focus-window")
  },
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
    claimShow: (input) =>
      ipcRenderer.invoke("yakitori:browser-show-claim", input),
    completeShow: (input) =>
      ipcRenderer.invoke("yakitori:browser-show-complete", input),
    onShowRequest(listener) {
      const handler = (_event, request) => listener(request)
      ipcRenderer.on("yakitori:browser-show-request", handler)
      return () =>
        ipcRenderer.removeListener("yakitori:browser-show-request", handler)
    },
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
    // Validate the entire batch before allocating or importing any file.
    if (input.files.some((file) => file.size > 50_000_000)) {
      throw new Error("Attachment must be a file no larger than 50 MB.")
    }
    const attachments = []
    try {
      for (const file of input.files) {
        // Await storage before reading the next pathless File. Only one file's
        // bytes cross IPC at a time; retained batch state contains references.
        const filePath = webUtils.getPathForFile(file)
        const item =
          filePath === ""
            ? {
                name: file.name,
                data: new Uint8Array(await file.arrayBuffer()),
              }
            : { name: file.name, filePath }
        const imported = await ipcRenderer.invoke(
          "yakitori:import-attachment-files",
          {
            ...(input.sessionId === undefined
              ? {}
              : { sessionId: input.sessionId }),
            items: [item],
          },
        )
        attachments.push(...imported)
      }
      return attachments
    } catch (cause) {
      // The main process owns cleanup of the failed file. Roll back earlier
      // files from this batch so callers still receive all attachments or none.
      if (attachments.length > 0) {
        try {
          await ipcRenderer.invoke(
            "yakitori:discard-draft-attachments",
            attachments,
          )
        } catch (cleanup) {
          throw new AggregateError(
            [cause, cleanup],
            "Attachment import and staging cleanup both failed.",
            { cause },
          )
        }
      }
      throw cause
    }
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
