import {
  type BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  session,
  WebContentsView,
} from "electron"
import { requireTrustedSender } from "./resource-opener.ts"
import type {
  WorkspaceBrowserSelection,
  WorkspaceBrowserShortcut,
  WorkspaceBrowserState,
  WorkspaceBrowserViewport,
} from "./workspace-browser-types.ts"
import {
  isBrowserNavigation,
  normalizeBrowserUrl,
} from "./workspace-browser-url.ts"

type BrowserTab = {
  view: WebContentsView
  navigation: number
  layout: number
  preview?: { navigation: number; dataUrl: string }
  requestedUrl?: string
  error?: string
}

export function registerWorkspaceBrowser(window: BrowserWindow): void {
  const tabs = new Map<string, BrowserTab>()
  // A dedicated profile never shares the trusted renderer's cookies or access.
  const profile = session.fromPartition("persist:yakitori-workspace-browser")
  profile.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  profile.setPermissionCheckHandler(() => false)

  function state(tabId: string, tab: BrowserTab): WorkspaceBrowserState {
    const contents = tab.view.webContents
    return {
      tabId,
      url:
        tab.requestedUrl ??
        (contents.getURL() === "about:blank" ? "" : contents.getURL()),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...(tab.error === undefined ? {} : { error: tab.error }),
    }
  }
  function publish(tabId: string, tab: BrowserTab) {
    if (
      !window.isDestroyed() &&
      tabs.get(tabId) === tab &&
      !tab.view.webContents.isDestroyed()
    ) {
      window.webContents.send("yakitori:browser-state", state(tabId, tab))
    }
  }
  function navigate(tabId: string, tab: BrowserTab, input: string) {
    const url = normalizeBrowserUrl(input)
    const navigation = ++tab.navigation
    tab.requestedUrl = url
    delete tab.error
    void tab.view.webContents.loadURL(url).catch((error: unknown) => {
      if (
        tabs.get(tabId) !== tab ||
        tab.navigation !== navigation ||
        tab.view.webContents.isDestroyed()
      )
        return
      // A newer navigation routinely aborts the previous load.
      if (error instanceof Error && "errno" in error && error.errno === -3)
        return
      tab.error = error instanceof Error ? error.message : String(error)
      publish(tabId, tab)
    })
  }
  function emitSelection(
    tabId: string,
    tab: BrowserTab,
    text: string,
    action: WorkspaceBrowserSelection["action"],
    source = {
      url: tab.view.webContents.getURL(),
      title: tab.view.webContents.getTitle(),
    },
  ) {
    // Bound copied page text so an accidental Select All cannot flood IPC/chat.
    const selected = text.trim().slice(0, 32_000)
    if (!selected || window.isDestroyed() || tabs.get(tabId) !== tab) return
    window.webContents.send("yakitori:browser-selection", {
      tabId,
      text: selected,
      ...source,
      action,
    } satisfies WorkspaceBrowserSelection)
  }
  function create(tabId: string, url?: string): BrowserTab {
    const existing = tabs.get(tabId)
    if (existing) return existing
    const initialUrl = url ? normalizeBrowserUrl(url) : undefined
    const view = new WebContentsView({
      webPreferences: {
        session: profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const tab: BrowserTab = { view, navigation: 0, layout: 0 }
    tabs.set(tabId, tab)
    view.setVisible(false)
    window.contentView.addChildView(view)
    const contents = view.webContents
    contents.on("before-input-event", (event, input) => {
      if (
        input.type !== "keyDown" ||
        input.isComposing ||
        input.isAutoRepeat ||
        !(input.meta || input.control)
      )
        return
      const key = input.key.toLowerCase()
      const action: WorkspaceBrowserShortcut | undefined =
        key === "t" && !input.alt && !input.shift
          ? "new-browser"
          : key === "p" && !input.alt && !input.shift
            ? "open-files"
            : key === "s" && input.alt && !input.shift
              ? "new-side-chat"
              : key === "b" && input.shift && !input.alt
                ? "toggle-workspace"
                : undefined
      if (!action || tabs.get(tabId) !== tab || window.isDestroyed()) return
      event.preventDefault()
      window.webContents.send("yakitori:browser-shortcut", action)
    })
    contents.on("did-start-loading", () => publish(tabId, tab))
    contents.on("did-stop-loading", () => publish(tabId, tab))
    contents.on("page-title-updated", () => publish(tabId, tab))
    contents.on("did-navigate", () => {
      delete tab.requestedUrl
      delete tab.error
      publish(tabId, tab)
    })
    contents.on("did-navigate-in-page", () => publish(tabId, tab))
    contents.on("will-navigate", (event, target) => {
      if (!isBrowserNavigation(target)) {
        event.preventDefault()
        return
      }
      tab.navigation += 1
      tab.requestedUrl = target
      delete tab.error
    })
    contents.on("will-redirect", (event, target) => {
      if (!isBrowserNavigation(target)) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url: target }) => {
      // Keep user-opened links inside the same isolated browser surface.
      if (isBrowserNavigation(target)) navigate(tabId, tab, target)
      return { action: "deny" }
    })
    contents.on(
      "did-fail-load",
      (_event, code, description, _url, mainFrame) => {
        if (!mainFrame || code === -3) return
        tab.error = description
        publish(tabId, tab)
      },
    )
    contents.on("render-process-gone", (_event, details) => {
      tab.error = `The page stopped (${details.reason}). Reload to try again.`
      publish(tabId, tab)
    })
    contents.on("context-menu", (_event, params) => {
      // Electron supplies the actual selection, including selections in frames.
      // Capture its source now; navigation after opening the menu cannot retarget it.
      const source = {
        url: params.frameURL || contents.getURL(),
        title: contents.getTitle(),
      }
      const selected = params.selectionText
      Menu.buildFromTemplate([
        ...(selected.trim()
          ? [
              {
                label: "Add to conversation",
                click: () => emitSelection(tabId, tab, selected, "add", source),
              },
              {
                label: "Ask in side chat",
                click: () =>
                  emitSelection(tabId, tab, selected, "chat", source),
              },
              { type: "separator" as const },
              { label: "Copy", click: () => clipboard.writeText(selected) },
            ]
          : [
              {
                label: "Back",
                enabled: contents.navigationHistory.canGoBack(),
                click: () => {
                  if (tabs.get(tabId) === tab)
                    contents.navigationHistory.goBack()
                },
              },
              {
                label: "Forward",
                enabled: contents.navigationHistory.canGoForward(),
                click: () => {
                  if (tabs.get(tabId) === tab)
                    contents.navigationHistory.goForward()
                },
              },
              {
                label: "Reload",
                click: () => {
                  if (tabs.get(tabId) !== tab) return
                  delete tab.error
                  contents.reload()
                },
              },
            ]),
      ]).popup({ window })
    })
    if (initialUrl) navigate(tabId, tab, initialUrl)
    return tab
  }
  const handlers = {
    create(input: Record<string, unknown>) {
      const tabId = requireTabId(input)
      if (input.url !== undefined && typeof input.url !== "string")
        throw new TypeError("Browser URL must be a string.")
      return state(tabId, create(tabId, input.url as string | undefined))
    },
    navigate(input: Record<string, unknown>) {
      const tabId = requireTabId(input)
      if (typeof input.url !== "string")
        throw new TypeError("Browser URL is required.")
      navigate(tabId, requireTab(tabId), input.url)
    },
    action(input: Record<string, unknown>) {
      const tabId = requireTabId(input)
      const tab = requireTab(tabId)
      const contents = tab.view.webContents
      switch (input.action) {
        case "back":
          if (contents.navigationHistory.canGoBack())
            contents.navigationHistory.goBack()
          break
        case "forward":
          if (contents.navigationHistory.canGoForward())
            contents.navigationHistory.goForward()
          break
        case "reload":
          delete tab.error
          contents.reload()
          break
        case "stop":
          contents.stop()
          break
        default:
          throw new TypeError("Unknown browser action.")
      }
    },
    async viewport(input: Record<string, unknown>) {
      const tabId = requireTabId(input)
      const tab = tabs.get(tabId)
      // A queued layout cleanup can arrive after close; it cannot revive a tab.
      if (!tab) return
      if (
        typeof input.visible !== "boolean" ||
        (input.occluded !== undefined && typeof input.occluded !== "boolean") ||
        !["x", "y", "width", "height"].every(
          (key) =>
            typeof input[key] === "number" && Number.isFinite(input[key]),
        )
      ) {
        throw new TypeError("Invalid browser viewport.")
      }
      const rect = input as WorkspaceBrowserViewport
      const layout = ++tab.layout
      const zoom = window.webContents.getZoomFactor()
      const bounds = window.getContentBounds()
      const x = Math.max(0, Math.min(bounds.width, Math.round(rect.x * zoom)))
      const y = Math.max(0, Math.min(bounds.height, Math.round(rect.y * zoom)))
      const width = Math.max(
        0,
        Math.min(bounds.width - x, Math.round(rect.width * zoom)),
      )
      const height = Math.max(
        0,
        Math.min(bounds.height - y, Math.round(rect.height * zoom)),
      )
      tab.view.setBounds({ x, y, width, height })
      const visible =
        rect.visible &&
        width > 0 &&
        height > 0 &&
        !tab.error &&
        Boolean(state(tabId, tab).url)
      if (visible) {
        for (const other of tabs.values()) {
          if (other !== tab) other.view.setVisible(false)
        }
      }
      if (visible && rect.occluded) {
        // Native pages sit above renderer overlays. Preserve the visible page
        // while its live view yields to a popup that actually overlaps it.
        // Layout changes under the same popup reuse its still image. The hidden
        // native view may no longer have a composited surface to capture.
        if (tab.preview?.navigation === tab.navigation)
          return tab.preview.dataUrl
        try {
          const image = await tab.view.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
          if (tabs.get(tabId) !== tab || tab.layout !== layout) return
          const dataUrl = image.toDataURL()
          tab.preview = { navigation: tab.navigation, dataUrl }
          return dataUrl
        } finally {
          if (tabs.get(tabId) === tab && tab.layout === layout)
            tab.view.setVisible(false)
        }
      }
      delete tab.preview
      if (!visible && tab.view.webContents.isFocused())
        window.webContents.focus()
      tab.view.setVisible(visible)
    },
    async selection(input: Record<string, unknown>) {
      const tabId = requireTabId(input)
      const tab = requireTab(tabId)
      if (input.action !== "add" && input.action !== "chat")
        throw new TypeError("Unknown selection action.")
      const source = {
        url: tab.view.webContents.getURL(),
        title: tab.view.webContents.getTitle(),
      }
      // Fixed code in an isolated world reads selected text without exposing IPC
      // or executing page-provided JavaScript in the trusted renderer.
      const text: unknown =
        await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [
          { code: "globalThis.getSelection()?.toString() ?? ''" },
        ])
      if (
        tabs.get(tabId) !== tab ||
        tab.view.webContents.isDestroyed() ||
        source.url !== tab.view.webContents.getURL()
      )
        throw new Error("The page changed. Select the text again.")
      if (typeof text !== "string" || !text.trim())
        throw new Error("Select text on the page first.")
      emitSelection(tabId, tab, text, input.action, source)
    },
    close(input: Record<string, unknown>) {
      const tabId = requireTabId(input)
      const tab = tabs.get(tabId)
      if (!tab) return
      closeTab(tabId, tab)
    },
  }
  function requireTab(tabId: string): BrowserTab {
    const tab = tabs.get(tabId)
    if (!tab) throw new Error("Browser tab is closed.")
    return tab
  }
  function closeTab(tabId: string, tab: BrowserTab) {
    tabs.delete(tabId)
    tab.view.setVisible(false)
    if (tab.view.webContents.isFocused() && !window.isDestroyed())
      window.webContents.focus()
    window.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed())
      tab.view.webContents.close({ waitForBeforeUnload: false })
  }
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        for (const [tabId, tab] of tabs) closeTab(tabId, tab)
      }
    },
  )
  window.webContents.on("render-process-gone", () => {
    for (const [tabId, tab] of tabs) closeTab(tabId, tab)
  })
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`yakitori:browser-${name}`, (event, input: unknown) => {
      requireTrustedSender(event.sender, event.senderFrame, window)
      if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new TypeError("Browser request must be an object.")
      return handler(input as Record<string, unknown>)
    })
  }
  window.on("closed", () => {
    for (const name of Object.keys(handlers))
      ipcMain.removeHandler(`yakitori:browser-${name}`)
    for (const tab of tabs.values()) {
      if (!tab.view.webContents.isDestroyed())
        tab.view.webContents.close({ waitForBeforeUnload: false })
    }
    tabs.clear()
  })
}

function requireTabId(input: Record<string, unknown>): string {
  if (typeof input.tabId !== "string" || !input.tabId.trim())
    throw new TypeError("Browser tab ID is required.")
  return input.tabId
}
