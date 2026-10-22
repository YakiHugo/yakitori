// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useNavigationHistory } from "../../src/gui/hooks/use-navigation-history.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import {
  initialEngineState,
  useEngineStore,
  chooseNewEngine,
} from "../../src/gui/store/engine-store.ts"

beforeEach(() => {
  localStorage.clear()
  useEngineStore.setState(initialEngineState, true)
})
afterEach(cleanup)

it("traverses settings, ignores unrelated updates and truncates forward history on a new visit", async () => {
  const { result } = renderHook(useNavigationHistory)
  expect(result.current.canGoBack).toBe(false)
  await act(async () => useAppStore.getState().openSettings("general"))
  await act(async () =>
    useAppStore.getState().setSettingsSection("notifications"),
  )
  await act(async () =>
    useAppStore.setState({ message: "A background update" }),
  )
  await act(async () => result.current.back())
  expect(useAppStore.getState().settingsSection).toBe("general")
  expect(result.current.canGoForward).toBe(true)
  await act(async () => result.current.back())
  expect(useAppStore.getState().settingsSection).toBeUndefined()
  expect(result.current.canGoBack).toBe(false)
  await act(async () => result.current.forward())
  expect(useAppStore.getState().settingsSection).toBe("general")
  await act(async () => useAppStore.getState().openSettings("mcp"))
  expect(result.current.canGoForward).toBe(false)
  await act(async () => result.current.back())
  expect(useAppStore.getState().settingsSection).toBe("general")
})

it("returns to project drafts without creating sessions", async () => {
  const createSession = vi.fn(async () => undefined)
  useAppStore.setState({
    currentProject: "project-a",
    sessionSelectionIntentRevision: 1,
    createSession,
  })
  const { result } = renderHook(useNavigationHistory)
  await act(async () =>
    useAppStore.getState().setNewSessionProject("project-b"),
  )
  await act(async () => result.current.back())
  expect(useAppStore.getState().currentProject).toBe("project-a")
  await act(async () => result.current.forward())
  expect(useAppStore.getState().currentProject).toBe("project-b")
  expect(createSession).not.toHaveBeenCalled()
})

it("replaces a draft when it receives a server ID rather than adding a second visit", async () => {
  const { result } = renderHook(useNavigationHistory)
  await act(async () => useAppStore.getState().openSettings("general"))
  await act(async () =>
    useAppStore.getState().clearSessionSelection({ projectId: "project-a" }),
  )
  await act(async () =>
    useAppStore.setState({ selection: { sessionId: "created-session" } }),
  )
  await act(async () => result.current.back())
  expect(useAppStore.getState().settingsSection).toBe("general")
  expect(useAppStore.getState().selection.sessionId).toBeUndefined()
})

it("coalesces cross-store engine selection and restores the engine draft", async () => {
  useAppStore.setState({
    currentProject: "project-a",
    sessionSelectionIntentRevision: 1,
  })
  const { result } = renderHook(useNavigationHistory)
  await act(async () => chooseNewEngine("acp"))
  await act(async () => result.current.back())
  expect(useEngineStore.getState().engineId).toBeUndefined()
  expect(result.current.canGoBack).toBe(false)
  await act(async () => result.current.forward())
  expect(useEngineStore.getState().engineId).toBe("acp")
  expect(useAppStore.getState().currentProject).toBe("project-a")
  expect(result.current.canGoForward).toBe(false)
})

it("drops destinations belonging to a previous API server", async () => {
  const { result } = renderHook(useNavigationHistory)
  await act(async () => useAppStore.getState().openSettings("general"))
  expect(result.current.canGoBack).toBe(true)
  await act(async () =>
    useAppStore.setState({ apiBase: "http://127.0.0.1:5999" }),
  )
  expect(result.current.canGoBack).toBe(false)
  expect(result.current.canGoForward).toBe(false)
})

it("traverses account creation, details and the model configuration pane", async () => {
  const { result } = renderHook(useNavigationHistory)
  const app = () => useAppStore.getState()
  await act(async () => app().openSettings("providers"))
  await act(async () => app().setProviderSettingsPage({ kind: "catalog" }))
  await act(async () => result.current.back())
  expect(app().providerSettingsPage).toEqual({ kind: "accounts" })
  await act(async () => result.current.forward())
  expect(app().providerSettingsPage).toEqual({ kind: "catalog" })
  await act(async () =>
    app().setProviderSettingsPage({
      kind: "account",
      accountKind: "configured",
      accountId: "work",
    }),
  )
  await act(async () =>
    app().setProviderSettingsPage({
      kind: "account",
      accountKind: "configured",
      accountId: "work",
      modelId: "coder",
    }),
  )
  await act(async () => result.current.back())
  expect(app().providerSettingsPage).toEqual({
    kind: "account",
    accountKind: "configured",
    accountId: "work",
  })
  await act(async () => result.current.forward())
  expect(app().providerSettingsPage).toEqual({
    kind: "account",
    accountKind: "configured",
    accountId: "work",
    modelId: "coder",
  })
})
