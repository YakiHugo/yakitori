import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type {
  WorkspaceBrowserShowRequest,
  WorkspaceBrowserShowResult,
  WorkspaceBrowserState,
} from "../../src/desktop/workspace-browser-types.ts"
import { connectBrowserViewRequests } from "../../src/gui/browser-view-requests.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import {
  selectWorkspacePresentation,
  useWorkspaceStore,
} from "../../src/gui/store/workspace-store.ts"

const request = {
  requestId: "browser_show_00000000-0000-4000-8000-000000000001",
  tabId: "browser",
  ownerSessionId: "owned",
}
const disconnects: (() => void)[] = []
beforeEach(() => {
  useWorkspaceStore.setState({
    sessionId: "owned",
    tabs: [
      { id: "changes", kind: "changes", workspaceSessionId: "owned" },
      { id: "browser", kind: "browser", workspaceSessionId: "owned" },
    ],
    presentationBySession: {
      owned: { open: false, expanded: false, activeId: "changes" },
      other: { open: false, expanded: false, activeId: undefined },
    },
  })
})
afterEach(() => {
  for (const disconnect of disconnects.splice(0)) disconnect()
})
function fixture() {
  let listener: ((request: WorkspaceBrowserShowRequest) => void) | undefined
  let tabListener: ((state: WorkspaceBrowserState) => void) | undefined
  const claim = Promise.withResolvers<boolean>(),
    acked = Promise.withResolvers<WorkspaceBrowserShowResult>()
  const bridge = {
    onShowRequest(fn: (request: WorkspaceBrowserShowRequest) => void) {
      listener = fn
      return () => {
        listener = undefined
      }
    },
    onState(fn: (state: WorkspaceBrowserState) => void) {
      tabListener = fn
      return () => {
        tabListener = undefined
      }
    },
    claimShow: vi.fn(async () => claim.promise),
    completeShow: vi.fn(
      async (input: {
        requestId: string
        result: WorkspaceBrowserShowResult
      }) => {
        acked.resolve(input.result)
        return true
      },
    ),
  }
  const disconnect = connectBrowserViewRequests(bridge)
  disconnects.push(disconnect)
  return {
    bridge,
    claim,
    acked,
    disconnect,
    emit(input = request) {
      if (!listener) throw new Error("No display listener")
      listener(input)
    },
    tab(state: WorkspaceBrowserState) {
      if (!tabListener) throw new Error("No tab state listener")
      tabListener(state)
    },
  }
}

it("adds a native popup beside its opener without switching workspaces, and removes it on close", () => {
  const f = fixture()
  const popup = {
    tabId: "popup_owned",
    openerTabId: "browser",
    title: "Popup",
    url: "https://owned.test",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }
  f.tab(popup)
  f.tab(popup)
  expect(
    useWorkspaceStore.getState().tabs.filter((tab) => tab.id === popup.tabId),
  ).toMatchObject([
    { id: popup.tabId, kind: "browser", workspaceSessionId: "owned" },
  ])
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe("changes")
  f.tab({ ...popup, closed: true })
  expect(
    useWorkspaceStore.getState().tabs.some((tab) => tab.id === popup.tabId),
  ).toBe(false)
})

it("changes workspace selection only after the native owner grants its claim", async () => {
  const f = fixture()
  f.emit()
  expect(f.bridge.claimShow).toHaveBeenCalledWith({
    requestId: request.requestId,
  })
  expect(selectWorkspacePresentation(useWorkspaceStore.getState())).toEqual({
    open: false,
    expanded: false,
    activeId: "changes",
  })
  f.claim.resolve(true)
  expect(await f.acked.promise).toBe("applied")
  expect(selectWorkspacePresentation(useWorkspaceStore.getState())).toEqual({
    open: true,
    expanded: false,
    activeId: "browser",
  })
  expect(f.bridge.completeShow).toHaveBeenCalledTimes(1)
})

it("maps a promoted session owner to its draft workspace", async () => {
  useAppStore.setState({ sessionThreadIds: { owned: "draft-owned" } })
  useWorkspaceStore.setState({
    sessionId: "draft-owned",
    tabs: [
      { id: "changes", kind: "changes", workspaceSessionId: "draft-owned" },
      { id: "browser", kind: "browser", workspaceSessionId: "draft-owned" },
    ],
    presentationBySession: {
      "draft-owned": { open: false, expanded: false, activeId: "changes" },
    },
  })
  const f = fixture()
  f.emit()
  f.claim.resolve(true)
  expect(await f.acked.promise).toBe("applied")
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
  ).toBe("browser")
})

it("does not apply a display request whose native claim expired or was cancelled", async () => {
  const f = fixture()
  f.emit()
  f.claim.resolve(false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(selectWorkspacePresentation(useWorkspaceStore.getState())).toEqual({
    open: false,
    expanded: false,
    activeId: "changes",
  })
  expect(f.bridge.completeShow).not.toHaveBeenCalled()
})

it.each([
  "conversation",
  "settings",
  "missing",
  "kind",
])("refuses a request outside the current browser workspace boundary (%s)", async (kind) => {
  const f = fixture()
  if (kind === "conversation") useWorkspaceStore.getState().setSession("other")
  if (kind === "settings")
    useAppStore.setState({ settingsSection: "providers" })
  f.emit({
    ...request,
    tabId:
      kind === "missing" ? "missing" : kind === "kind" ? "changes" : "browser",
  })
  expect(await f.acked.promise).toBe("refused")
  expect(f.bridge.claimShow).not.toHaveBeenCalled()
  expect(selectWorkspacePresentation(useWorkspaceStore.getState()).open).toBe(
    false,
  )
})

it.each([
  "session",
  "unmount",
])("does not apply a late claim after %s changes its scope", async (terminal) => {
  const f = fixture()
  f.emit()
  if (terminal === "session") useWorkspaceStore.getState().setSession("other")
  else f.disconnect()
  f.claim.resolve(true)
  expect(await f.acked.promise).toBe("refused")
  expect(selectWorkspacePresentation(useWorkspaceStore.getState()).open).toBe(
    false,
  )
  expect(useWorkspaceStore.getState().presentationBySession.owned).toEqual({
    open: false,
    expanded: false,
    activeId: "changes",
  })
})
