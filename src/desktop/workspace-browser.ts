import { randomUUID } from "node:crypto"
import {
  type BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  session,
  type WebContents,
  WebContentsView,
} from "electron"
import {
  BrowserControlError,
  type BrowserOwner,
  type DesktopBrowser,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"
import { BrowserDocumentConnection } from "./browser-observation.ts"
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
  instanceId: string
  view: WebContentsView
  navigation: number
  layout: number
  preview?: { navigation: number; dataUrl: string }
  requestedUrl?: string
  error?: string
}

export function registerWorkspaceBrowser(
  window: BrowserWindow,
): DesktopBrowser {
  const tabs = new Map<string, BrowserTab>()
  const loads = new Set<string>()
  type OwnedConnection = {
    owner: BrowserOwner
    targetId: string
    contents: WebContents
    connection: BrowserDocumentConnection
    busy: boolean
  }
  // One current debugger per turn. Switching tabs closes the previous target;
  // model steps reuse the connection until the owning turn confirms cleanup.
  const connections = new Map<string, OwnedConnection>()
  const isAgentOwned = (tab: BrowserTab) =>
    [...connections.values()].some((entry) => entry.targetId === tab.instanceId)
  const closeConnection = async (key: string, entry: OwnedConnection) => {
    await entry.connection.close()
    if (!entry.contents.isDestroyed())
      entry.contents.setIgnoreMenuShortcuts(false)
    connections.delete(key)
  }
  const ownerKey = (owner: BrowserOwner) =>
    JSON.stringify([owner.sessionId, owner.turnId])
  const finishTurn = async (owner: BrowserOwner) => {
    const key = ownerKey(owner),
      entry = connections.get(key)
    if (!entry) return
    entry.busy = true
    try {
      await closeConnection(key, entry)
    } finally {
      entry.busy = false
    }
  }

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
    const tab: BrowserTab = {
      view,
      instanceId: `browser_target_${randomUUID()}`,
      navigation: 0,
      layout: 0,
    }
    tabs.set(tabId, tab)
    view.setVisible(false)
    const initialBounds = window.getContentBounds()
    view.setBounds({
      x: 0,
      y: 0,
      width: Math.max(1, initialBounds.width),
      height: Math.max(1, initialBounds.height),
    })
    window.contentView.addChildView(view)
    const contents = view.webContents
    contents.on("before-input-event", (event, input) => {
      if (isAgentOwned(tab)) return
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
      // Page contextmenu handlers still receive the trusted pointer event.
      // An agent-owned target must not open the host's native menu over the
      // user's desktop, even when its CDP acknowledgement arrives first.
      if (isAgentOwned(tab)) return
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
          if (contents.navigationHistory.canGoBack()) {
            tab.navigation++
            contents.navigationHistory.goBack()
          }
          break
        case "forward":
          if (contents.navigationHistory.canGoForward()) {
            tab.navigation++
            contents.navigationHistory.goForward()
          }
          break
        case "reload":
          tab.navigation++
          delete tab.error
          contents.reload()
          break
        case "stop":
          tab.navigation++
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
      // Unmount cleanup hides the native surface; retain its last logical
      // viewport so background CDP input and captures do not collapse to 0x0.
      if (width > 0 && height > 0) tab.view.setBounds({ x, y, width, height })
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
        const navigation = tab.navigation
        try {
          const image = await tab.view.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
          if (
            tabs.get(tabId) !== tab ||
            tab.layout !== layout ||
            tab.navigation !== navigation
          )
            return
          const dataUrl = image.toDataURL()
          tab.preview = { navigation, dataUrl }
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
  return {
    async request(input, owner, signal = new AbortController().signal) {
      signal.throwIfAborted()
      if (window.isDestroyed())
        throw new BrowserControlError(
          "browser_unavailable",
          "The desktop window is closed.",
        )
      if (input.action === "list") {
        const current = [...tabs].filter(
          ([, tab]) => !tab.view.webContents.isDestroyed(),
        )
        const listed: JsonObject[] = []
        let offset = input.offset ?? 0,
          bytes = 0
        for (; offset < current.length; offset++) {
          const entry = current[offset]
          if (!entry)
            throw new Error("Browser catalog index changed synchronously.")
          const [tabId, tab] = entry
          const url = tab.view.webContents.getURL(),
            title = tab.view.webContents.getTitle()
          const item = {
            target: {
              tabId,
              webContentsId: tab.view.webContents.id,
              instanceId: tab.instanceId,
            },
            url: url.slice(0, 8192),
            title: title.slice(0, 2048),
            metadataTruncated: url.length > 8192 || title.length > 2048,
            loading: tab.view.webContents.isLoadingMainFrame(),
          }
          const size = Buffer.byteLength(JSON.stringify(item))
          // Bound one catalog reply while keeping later targets reachable.
          if (bytes + size > 256 * 1024) break
          listed.push(item)
          bytes += size
        }
        return {
          tabs: listed,
          ...(offset < current.length ? { nextOffset: offset } : {}),
        }
      }
      const { target } = input
      const tab = tabs.get(target.tabId)
      if (
        !tab ||
        tab.view.webContents.isDestroyed() ||
        tab.view.webContents.id !== target.webContentsId ||
        tab.instanceId !== target.instanceId
      )
        throw new BrowserControlError(
          "browser_target_changed",
          "The listed browser tab closed or was replaced. List targets again.",
        )
      if (loads.has(target.instanceId))
        throw new BrowserControlError(
          "browser_busy",
          "An agent navigation is still settling for this target.",
        )
      if (input.action === "navigate") {
        if (!isBrowserNavigation(input.url))
          throw new BrowserControlError(
            "invalid_arguments",
            "Use an HTTP(S) destination without credentials.",
          )
        const current = connections.get(ownerKey(owner))
        if (
          current?.busy ||
          [...connections.values()].some(
            (entry) =>
              entry !== current && entry.targetId === target.instanceId,
          )
        )
          throw new BrowserControlError(
            "browser_busy",
            "This browser target has an active owner or request.",
          )
        const contents = tab.view.webContents
        const assertCurrent = () => {
          signal.throwIfAborted()
          if (
            tabs.get(target.tabId) !== tab ||
            contents.isDestroyed() ||
            contents.getURL() !== input.fromUrl ||
            contents.isLoadingMainFrame()
          )
            throw new BrowserControlError(
              "browser_target_changed",
              "The listed page changed or is loading. List its current URL before navigating.",
            )
        }
        assertCurrent()
        await finishTurn(owner)
        assertCurrent()
        const navigation = ++tab.navigation
        tab.requestedUrl = input.url
        delete tab.error
        const cancel = () => {
          // A later user navigation owns its load. Never stop that replacement.
          if (
            tabs.get(target.tabId) === tab &&
            tab.navigation === navigation &&
            !contents.isDestroyed()
          )
            contents.stop()
        }
        signal.addEventListener("abort", cancel, { once: true })
        loads.add(target.instanceId)
        try {
          signal.throwIfAborted()
          // Wait for Electron's load completion/rejection, including cancellation.
          // Abandoning this promise would make a retry duplicate navigation.
          await contents.loadURL(input.url)
          signal.throwIfAborted()
          if (
            tabs.get(target.tabId) !== tab ||
            contents.isDestroyed() ||
            tab.navigation !== navigation
          )
            throw new BrowserControlError(
              "browser_target_changed",
              "A later navigation or replacement superseded this load. Inspect the current tab.",
            )
          return { target, url: contents.getURL(), loaded: true }
        } catch (cause) {
          if (
            cause instanceof Error &&
            "errno" in cause &&
            typeof cause.errno === "number" &&
            cause.errno < 0
          )
            throw new BrowserControlError(
              "browser_navigation_unconfirmed",
              "The requested load failed or was superseded. Inspect the current URL; do not retry automatically. " +
                cause.message,
            )
          throw cause
        } finally {
          signal.removeEventListener("abort", cancel)
          loads.delete(target.instanceId)
        }
      }
      const key = ownerKey(owner)
      let entry = connections.get(key)
      if (
        entry?.busy ||
        [...connections.values()].some(
          (current) =>
            current !== entry && current.targetId === target.instanceId,
        )
      )
        throw new BrowserControlError(
          "browser_busy",
          "This browser target already has an active owner or request.",
        )
      if (
        entry &&
        (entry.targetId !== target.instanceId || entry.connection.closed)
      ) {
        entry.busy = true
        try {
          await closeConnection(key, entry)
        } finally {
          entry.busy = false
        }
        entry = undefined
      }
      if (
        !entry &&
        input.action !== "observe" &&
        input.action !== "capture" &&
        input.action !== "frames"
      )
        throw new BrowserControlError(
          "browser_reference_stale",
          "Observe this target in the current turn before typing.",
        )
      if (!entry) {
        entry = {
          owner,
          targetId: target.instanceId,
          contents: tab.view.webContents,
          connection: new BrowserDocumentConnection(tab.view.webContents),
          busy: false,
        }
        connections.set(key, entry)
        // Agent key events belong to the page. App menu accelerators and the
        // renderer's workspace shortcuts resume only after confirmed cleanup.
        entry.contents.setIgnoreMenuShortcuts(true)
      }
      entry.busy = true
      let observation: JsonObject
      try {
        switch (input.action) {
          case "frames":
            observation = await entry.connection.frames(
              input.offset ?? 0,
              signal,
            )
            break
          case "capture":
            observation = await entry.connection.capture(input, signal)
            break
          case "observe":
            observation = await entry.connection.observe(
              signal,
              input.frameReference,
            )
            break
          case "press":
            observation = await entry.connection.pressKey(input, signal)
            break
          case "click":
          case "hover":
          case "scroll":
            observation = await entry.connection.inputPointer(input, signal)
            break
          case "type":
          case "fill":
            observation = await entry.connection.inputText(input, signal)
            break
        }
      } finally {
        entry.busy = false
      }
      if (tabs.get(target.tabId) !== tab || tab.view.webContents.isDestroyed())
        throw new BrowserControlError(
          "browser_target_changed",
          "The browser tab closed during observation.",
        )
      return { target, ...observation }
    },
    finishTurn,
    async closeSession(sessionId) {
      const results = await Promise.allSettled(
        [...connections.values()]
          .filter((entry) => entry.owner.sessionId === sessionId)
          .map((entry) => finishTurn(entry.owner)),
      )
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )
      if (errors.length)
        throw new AggregateError(errors, "Browser session cleanup failed.")
    },
  }
}

function requireTabId(input: Record<string, unknown>): string {
  if (typeof input.tabId !== "string" || !input.tabId.trim())
    throw new TypeError("Browser tab ID is required.")
  return input.tabId
}
