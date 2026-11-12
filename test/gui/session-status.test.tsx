// @vitest-environment happy-dom
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ApiSessionDetail,
  ApiSessionSummary,
} from "../../src/protocol/application.ts"
import { SessionItems } from "../../src/gui/components/sidebar-sessions.tsx"
import { useSessionRead } from "../../src/gui/hooks/use-session-read.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { useEngineStore } from "../../src/gui/store/engine-store.ts"
import {
  sessionReadKey,
  useSessionReadStore,
} from "../../src/gui/store/session-read-store.ts"

const summary: ApiSessionSummary = {
  id: "session_status",
  conversationId: "session_status",
  title: "Review changes",
  seq: 20,
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
  status: "idle",
  latestCompletionSeq: 12,
}
const detail: ApiSessionDetail = {
  ...summary,
  pendingInputs: [],
  pendingPermissions: [],
  counts: {
    inputs: 1,
    pendingInputs: 0,
    turns: 1,
    items: 2,
    permissions: 0,
    tools: 0,
  },
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(createInitialAppState())
  useAppStore.setState((state) => ({
    execution: { ...state.execution, lastSeq: 20 },
  }))
  useEngineStore.setState({ engineId: undefined })
  useSessionReadStore.setState({ readSeqs: {} })
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("sidebar session status", () => {
  it("shows five states in the title gutter and preserves unread beneath execution states", () => {
    const sessions: ApiSessionSummary[] = [
      {
        ...summary,
        id: "working",
        title: "Working row",
        status: "working",
        active: true,
      },
      {
        ...summary,
        id: "waiting",
        title: "Waiting row",
        status: "waiting",
        active: true,
      },
      { ...summary, id: "failed", title: "Failed row", status: "failed" },
      { ...summary, id: "unread", title: "Unread row" },
      { ...summary, id: "idle", title: "Idle row", latestCompletionSeq: 0 },
    ]
    useAppStore.setState({ sessionsByProject: { "": { sessions } } })
    render(<SessionItems />)

    for (const session of sessions)
      expect(
        screen.getByRole("button", {
          name: session.title ?? "Untitled session",
        }),
      ).toBeDefined()
    expect(screen.getByRole("status", { name: "Working" })).toBeDefined()
    expect(
      screen.getByRole("status", { name: "Waiting for you" }),
    ).toBeDefined()
    expect(screen.getByRole("status", { name: "Failed" })).toBeDefined()
    expect(screen.getByRole("status", { name: "Unread result" })).toBeDefined()
    const idle = screen.getByRole("button", { name: "Idle row" })
    expect(idle.querySelector('[data-status="idle"]')).not.toBeNull()
    act(() => {
      useAppStore.setState({
        sessionsByProject: {
          "": {
            sessions: sessions.map((session) => ({
              ...session,
              status: "idle",
              active: false,
            })),
          },
        },
      })
    })
    expect(
      screen.getAllByRole("status", { name: "Unread result" }),
    ).toHaveLength(4)
  })

  it("clears only the acknowledged session result and reveals later completions", () => {
    useAppStore.setState({
      apiBase: "http://server-a",
      sessionsByProject: { "": { sessions: [summary] } },
    })
    render(<SessionItems />)
    act(() =>
      useSessionReadStore
        .getState()
        .markRead("http://server-b", summary.id, 99),
    )
    expect(screen.getByRole("status", { name: "Unread result" })).toBeDefined()
    act(() =>
      useSessionReadStore
        .getState()
        .markRead("http://server-a", summary.id, 12),
    )
    expect(screen.queryByRole("status", { name: "Unread result" })).toBeNull()
    act(() =>
      useAppStore.setState({
        sessionsByProject: {
          "": { sessions: [{ ...summary, latestCompletionSeq: 21 }] },
        },
      }),
    )
    expect(screen.getByRole("status", { name: "Unread result" })).toBeDefined()
    act(() =>
      useSessionReadStore.getState().markRead("http://server-a", summary.id, 4),
    )
    expect(useSessionReadStore.getState().readSeqs).toEqual({
      [sessionReadKey("http://server-a", summary.id)]: 12,
      [sessionReadKey("http://server-b", summary.id)]: 99,
    })
  })
})

describe("session read acknowledgement", () => {
  it("preserves another tab's persisted reads when a stale tab reads a different session", () => {
    const markRead = useSessionReadStore.getState().markRead
    markRead("http://server-a", "session_a", 12)
    const firstKey = localStorage.key(0)
    if (firstKey === null) throw new Error("Missing persisted read")
    useSessionReadStore.setState({ readSeqs: {} })
    markRead("http://server-a", "session_b", 25)
    expect(localStorage.length).toBe(2)
    expect(localStorage.getItem(firstKey)).toBe("12")
    useSessionReadStore.getState().syncFromStorage()
    expect(useSessionReadStore.getState().readSeqs).toEqual({
      [sessionReadKey("http://server-a", "session_a")]: 12,
      [sessionReadKey("http://server-a", "session_b")]: 25,
    })
  })

  it("keeps a newer persisted watermark when a stale tab acknowledges an older result", () => {
    const markRead = useSessionReadStore.getState().markRead
    markRead("http://server-a", summary.id, 20)
    useSessionReadStore.setState({ readSeqs: {} })
    markRead("http://server-a", summary.id, 4)
    useSessionReadStore.setState({ readSeqs: {} })
    useSessionReadStore.getState().syncFromStorage()
    expect(Object.values(useSessionReadStore.getState().readSeqs)).toEqual([20])
  })

  it("updates unread indicators across tabs and repairs a concurrent older write", () => {
    const apiBase = useAppStore.getState().apiBase
    useSessionReadStore.getState().markRead(apiBase, summary.id, 12)
    const storageKey = localStorage.key(0)
    if (storageKey === null) throw new Error("Missing persisted read")
    useSessionReadStore.setState({ readSeqs: {} })
    useAppStore.setState({ sessionsByProject: { "": { sessions: [summary] } } })
    render(<SessionItems />)
    renderHook(() => useSessionRead())
    expect(screen.getByRole("status", { name: "Unread result" })).toBeDefined()
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: storageKey,
          storageArea: localStorage,
        }),
      ),
    )
    expect(screen.queryByRole("status", { name: "Unread result" })).toBeNull()
    localStorage.setItem(storageKey, "4")
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: storageKey,
          storageArea: localStorage,
        }),
      ),
    )
    expect(localStorage.getItem(storageKey)).toBe("12")
    expect(screen.queryByRole("status", { name: "Unread result" })).toBeNull()
  })

  it("does not acknowledge a completion until its transcript has replayed", () => {
    useAppStore.setState((state) => ({
      selection: { sessionId: detail.id },
      selectedSession: detail,
      execution: { ...state.execution, lastSeq: 5 },
    }))
    renderHook(() => useSessionRead())
    expect(useSessionReadStore.getState().readSeqs).toEqual({})
    act(() =>
      useAppStore.setState((state) => ({
        execution: { ...state.execution, lastSeq: 12 },
      })),
    )
    expect(Object.values(useSessionReadStore.getState().readSeqs)).toEqual([12])
  })

  it("waits for hydration and a focused, visible conversation", () => {
    useAppStore.setState({
      selection: { sessionId: detail.id },
      selectedSession: detail,
      hydratingSessionId: detail.id,
    })
    renderHook(() => useSessionRead())
    expect(useSessionReadStore.getState().readSeqs).toEqual({})
    act(() =>
      useAppStore.setState({
        hydratingSessionId: undefined,
        settingsSection: "general",
      }),
    )
    expect(useSessionReadStore.getState().readSeqs).toEqual({})
    vi.mocked(document.hasFocus).mockReturnValue(false)
    act(() => useAppStore.setState({ settingsSection: undefined }))
    expect(useSessionReadStore.getState().readSeqs).toEqual({})
    vi.mocked(document.hasFocus).mockReturnValue(true)
    act(() => window.dispatchEvent(new Event("focus")))
    expect(Object.values(useSessionReadStore.getState().readSeqs)).toEqual([12])
  })

  it("keeps results unread while an external engine or a background tab is visible", () => {
    useAppStore.setState({
      selection: { sessionId: detail.id },
      selectedSession: detail,
    })
    useEngineStore.setState({ engineId: "external" })
    renderHook(() => useSessionRead())
    expect(useSessionReadStore.getState().readSeqs).toEqual({})
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    act(() => useEngineStore.setState({ engineId: undefined }))
    expect(useSessionReadStore.getState().readSeqs).toEqual({})
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    act(() => document.dispatchEvent(new Event("visibilitychange")))
    expect(Object.values(useSessionReadStore.getState().readSeqs)).toEqual([12])
  })
})
