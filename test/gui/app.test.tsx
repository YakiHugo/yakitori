// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SidebarChange } from "../../src/core/session-sidebar.ts"
import { App } from "../../src/gui/app.tsx"
import {
  createExecutionViewState,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  createInitialAppState,
  sessionListKey,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  createEventEnvelope,
  EventType,
  InputRole,
  type StoredEventEnvelope,
} from "../../src/kernel/events.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"

const sessionId = "session_1"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("app shell", () => {
  it("renders an alert with the store error message", () => {
    useAppStore.setState({
      message: "Could not open event stream.",
      // The pinned sidebar group auto-loads on mount, and starting that task
      // clears the transient message; seed the list as already loaded.
      sessionsByProject: {
        [sessionListKey(undefined, { sectionId: "pinned" })]: { sessions: [] },
      },
    })
    render(<App />)

    expect(screen.getByRole("alert").textContent).toBe(
      "Could not open event stream.",
    )
  })

  it("restores an archived session via the composer restore button", async () => {
    const user = userEvent.setup()
    const changeSidebar = vi.fn((_change: SidebarChange) =>
      Promise.resolve(true),
    )
    useAppStore.setState({
      selection: { sessionId },
      selectedSession: sessionDetail({ archived: true }),
      changeSidebar,
    })
    render(<App />)

    await user.click(
      screen.getByRole("button", { name: "Restore conversation" }),
    )

    expect(changeSidebar).toHaveBeenCalledWith({
      type: "session",
      sessionId,
      archived: false,
    })
  })

  it("keeps the interrupt action available for an archived active turn", async () => {
    const user = userEvent.setup()
    const cancelTurn = vi.fn((_turnId: string) => Promise.resolve())
    useAppStore.setState({
      selection: { sessionId },
      selectedSession: sessionDetail({
        archived: true,
        activeTurnId: "turn_1",
      }),
      execution: seedExecution([
        createEventEnvelope({
          sessionId,
          seq: 1,
          event: {
            type: EventType.TurnStarted,
            data: { turnId: "turn_1", inputId: "input_1" },
          },
        }),
      ]),
      cancelTurn,
    })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "Interrupt" }))

    expect(cancelTurn).toHaveBeenCalledWith("turn_1")
    expect(
      screen.getByRole("button", { name: "Restore conversation" }),
    ).toBeDefined()
  })

  it("opens the parent session from the fork chip", async () => {
    const user = userEvent.setup()
    const selectSession = vi.fn((_selectedId: string) => Promise.resolve())
    useAppStore.setState({
      selection: { sessionId },
      selectedSession: sessionDetail({ parentSessionId: "session_parent" }),
      selectSession,
    })
    render(<App />)

    await user.click(screen.getByRole("button", { name: "fork from parent" }))

    expect(selectSession).toHaveBeenCalledWith("session_parent")
  })

  it("lists queued follow-ups without the removed activity status bar", () => {
    useAppStore.setState({
      selection: { sessionId },
      selectedSession: sessionDetail({ activeTurnId: "turn_1" }),
      execution: seedExecution([
        createEventEnvelope({
          sessionId,
          seq: 1,
          event: {
            type: EventType.TurnStarted,
            data: { turnId: "turn_1", inputId: "input_1" },
          },
        }),
        createEventEnvelope({
          sessionId,
          seq: 2,
          event: {
            type: EventType.InputAdmitted,
            data: {
              requestId: "request:2",
              inputId: "input_2",
              role: InputRole.User,
              content: { kind: "text", text: "queued follow-up" },
            },
          },
        }),
      ]),
    })
    render(<App />)

    const cancel = screen.getByRole("button", { name: "Cancel queued input" })
    const row = cancel.closest("div")
    if (row === null) throw new Error("Expected the queued input row")
    expect(within(row).getByText("queued follow-up")).toBeDefined()
    expect(within(row).getByText("queued")).toBeDefined()
    // The old status bar's activity label and elapsed time are gone.
    expect(screen.queryByText("Reasoning")).toBeNull()
    expect(screen.queryByText(/· 0s/)).toBeNull()
  })
})

function sessionDetail(
  overrides: Partial<ApiSessionDetail> = {},
): ApiSessionDetail {
  return {
    id: sessionId,
    conversationId: "conversation_1",
    projectId: "project_1",
    title: "Session",
    createdAt: "2026-09-12T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    seq: 1,
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      turns: 1,
      inputs: 1,
      tools: 0,
      pendingInputs: 0,
      items: 0,
      permissions: 0,
    },
    ...overrides,
  }
}

function seedExecution(events: StoredEventEnvelope[]) {
  return events.reduce(
    (current, event) =>
      reduceExecutionView(current, {
        type: "durable",
        event,
      }),
    createExecutionViewState(),
  )
}
