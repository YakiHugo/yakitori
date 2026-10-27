import { act, cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  EngineConversation,
  EngineSelector,
} from "../../src/gui/components/engine-session.tsx"
import { projectEngineSession } from "../../src/gui/engine-session-view.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import {
  cancelEngineTurn,
  chooseNewEngine,
  initialEngineState,
  selectEngineSession,
  sendEngineInput,
  useEngineStore,
} from "../../src/gui/store/engine-store.ts"
import type {
  EngineDescriptor,
  EngineEvent,
  EngineSessionSnapshot,
} from "../../src/protocol/engine.ts"

const request = vi.hoisted(() => vi.fn())
vi.mock("../../src/gui/lib/rpc-client.ts", async (original) => ({
  ...(await original<object>()),
  getAppRpcClient: () => ({ request }),
}))
const engine: EngineDescriptor = {
  id: "external",
  kind: "acp",
  available: true,
  label: "External Agent",
  capabilities: {
    resume: false,
    load: true,
    list: false,
    fork: false,
    steer: false,
    queue: false,
    subagents: false,
  },
}
function snapshot(events: EngineEvent[] = []): EngineSessionSnapshot {
  return {
    session: {
      id: "external_session",
      engineId: engine.id,
      cwd: "/workspace",
      createdAt: 1,
      updatedAt: 1,
    },
    events: events.map((event, index) => ({
      seq: index + 1,
      event,
      createdAt: 1,
    })),
    requests: [],
    history: "observed",
  }
}
const permission: EngineEvent = {
  type: "permission.requested",
  requestId: "permission",
  turnId: "turn",
  description: "Run command",
  toolCall: { rawInput: { command: "printf safe" } },
  options: [
    { id: "allow", label: "Allow once" },
    { id: "deny", label: "Reject" },
  ],
}
beforeEach(() => {
  request.mockReset()
  localStorage.clear()
  useEngineStore.setState({ ...initialEngineState, engines: [engine] }, true)
})
afterEach(cleanup)

describe("external engine workspace", () => {
  it("projects the accepted input before an already completed answer and ignores load replay", () => {
    const view = projectEngineSession(
      snapshot([
        { type: "turn.status", turnId: "turn", status: "running" },
        {
          type: "message.delta",
          turnId: "turn",
          channel: "assistant",
          text: "answer",
        },
        permission,
        {
          type: "session.update",
          turnId: "turn",
          replayed: true,
          update: { sessionUpdate: "tool_call", title: "Old replay" },
        },
        { type: "turn.status", turnId: "turn", status: "completed" },
        {
          type: "input.submitted",
          requestId: "request",
          turnId: "turn",
          text: "question",
        },
      ]),
    )
    expect(view.turns).toEqual([
      {
        id: "turn",
        input: "question",
        assistant: "answer",
        reasoning: "",
        updates: [],
        status: "completed",
      },
    ])
    expect(view.permissions).toEqual([])
    expect(view.activeTurnId).toBeUndefined()
  })

  it("shows command details and actual ACP options without native-only controls", async () => {
    const user = userEvent.setup()
    const current = snapshot([
      { type: "turn.status", turnId: "turn", status: "running" },
      permission,
    ])
    useEngineStore.setState({
      engineId: engine.id,
      sessionId: current.session.id,
      snapshot: current,
    })
    request.mockImplementation(async (method) =>
      method === "engineSession/read"
        ? snapshot([
            {
              type: "permission.resolved",
              requestId: "permission",
              turnId: "turn",
              optionId: "allow",
            },
          ])
        : true,
    )
    render(<EngineConversation />)
    expect(screen.getByText(/printf safe/)).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Select model and effort" }),
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "Add context" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Allow once" }))
    expect(request).toHaveBeenCalledWith("engineSession/respondPermission", {
      sessionId: "external_session",
      turnId: "turn",
      requestId: "permission",
      optionId: "allow",
    })
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
  })

  it("keeps the turn active after cancel acknowledgement until a terminal snapshot", async () => {
    const running = snapshot([
      { type: "turn.status", turnId: "turn", status: "running" },
    ])
    useEngineStore.setState({
      engineId: engine.id,
      sessionId: running.session.id,
      snapshot: running,
    })
    request.mockImplementation(async (method) =>
      method === "engineSession/cancel" ? { status: "requested" } : running,
    )
    await cancelEngineTurn("turn")
    expect(useEngineStore.getState().stopping).toBe(true)
    const observed = useEngineStore.getState().snapshot
    if (!observed) throw new Error("Expected an observed snapshot")
    expect(projectEngineSession(observed).activeTurnId).toBe("turn")
    render(<EngineConversation />)
    expect(
      (
        screen.getByRole("button", {
          name: "Stopping",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
    const finished = snapshot([
      { type: "turn.status", turnId: "turn", status: "cancelled" },
    ])
    request.mockResolvedValue(finished)
    await act(() => selectEngineSession(finished.session))
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy()
  })

  it("Escape in the engine composer interrupts its addressed turn and preserves the draft", async () => {
    const running = snapshot([
      { type: "turn.status", turnId: "turn", status: "running" },
    ])
    useEngineStore.setState({
      engineId: engine.id,
      sessionId: running.session.id,
      snapshot: running,
    })
    request.mockImplementation(async (method) =>
      method === "engineSession/cancel" ? { status: "requested" } : running,
    )
    render(<EngineConversation />)
    const user = userEvent.setup()
    const editor = screen.getByRole("textbox")
    await user.click(editor)
    await user.keyboard("next question{Escape}")
    expect(request).toHaveBeenCalledWith("engineSession/cancel", {
      sessionId: "external_session",
      turnId: "turn",
    })
    expect(editor.textContent).toContain("next question")
    expect(screen.getByRole("button", { name: "Stopping" })).toHaveProperty(
      "disabled",
      true,
    )
  })

  it("does not carry an interrupt into the next active engine turn", async () => {
    const running = snapshot([
      { type: "turn.status", turnId: "turn", status: "running" },
    ])
    useEngineStore.setState({
      engineId: engine.id,
      sessionId: running.session.id,
      snapshot: running,
    })
    const next = snapshot([
      { type: "turn.status", turnId: "turn", status: "cancelled" },
      { type: "turn.status", turnId: "next", status: "running" },
    ])
    request.mockImplementation(async (method) =>
      method === "engineSession/cancel" ? { status: "requested" } : next,
    )
    await cancelEngineTurn("turn")
    expect(useEngineStore.getState().stopping).toBe(false)
    await cancelEngineTurn("turn")
    expect(
      request.mock.calls.filter(
        ([method]) => method === "engineSession/cancel",
      ),
    ).toHaveLength(1)
    await cancelEngineTurn("next")
    expect(request).toHaveBeenCalledWith("engineSession/cancel", {
      sessionId: running.session.id,
      turnId: "next",
    })
  })

  it("a late cancel acknowledgement does not refresh a different engine selection", async () => {
    const running = snapshot([
      { type: "turn.status", turnId: "turn", status: "running" },
    ])
    useEngineStore.setState({
      engineId: engine.id,
      sessionId: running.session.id,
      snapshot: running,
    })
    let acknowledge!: () => void
    request.mockImplementation(async (method) => {
      if (method === "engineSession/cancel")
        await new Promise<void>((resolve) => {
          acknowledge = resolve
        })
      return running
    })
    const cancelling = cancelEngineTurn("turn")
    chooseNewEngine("another_engine")
    acknowledge()
    await cancelling
    expect(request).not.toHaveBeenCalledWith(
      "engineSession/read",
      expect.anything(),
    )
    expect(useEngineStore.getState().engineId).toBe("another_engine")
    expect(useEngineStore.getState().stopping).toBe(false)
  })

  it("allows retry after an engine interrupt fails", async () => {
    const running = snapshot([
      { type: "turn.status", turnId: "turn", status: "running" },
    ])
    useEngineStore.setState({
      engineId: engine.id,
      sessionId: running.session.id,
      snapshot: running,
    })
    request.mockRejectedValueOnce(new Error("cancel unavailable"))
    await cancelEngineTurn("turn")
    expect(useEngineStore.getState().stopping).toBe(false)
    expect(useEngineStore.getState().error).toContain("cancel unavailable")
    request.mockImplementation(async (method) =>
      method === "engineSession/cancel" ? { status: "requested" } : running,
    )
    await cancelEngineTurn("turn")
    expect(useEngineStore.getState().stopping).toBe(true)
  })

  it("does not create a native session when switching engine or selecting external history", async () => {
    const createNative = vi.fn()
    useAppStore.setState({ createSession: createNative })
    render(<EngineSelector />)
    const user = userEvent.setup()
    await user.click(
      screen.getByRole("combobox", { name: "New session engine" }),
    )
    await user.click(screen.getByRole("option", { name: engine.label }))
    expect(createNative).not.toHaveBeenCalled()
    request.mockResolvedValue(snapshot())
    await selectEngineSession(snapshot().session)
    expect(createNative).not.toHaveBeenCalled()
    expect(useEngineStore.getState().sessionId).toBe("external_session")
  })

  it("clears native running state when switching back from an external draft", () => {
    const app = useAppStore.getState()
    useAppStore.setState({
      selection: { sessionId: "native" },
      execution: { ...app.execution, activeTurnId: "native_turn" },
    })
    chooseNewEngine("external")
    chooseNewEngine("")
    expect(useAppStore.getState().selection).toEqual({})
    expect(useAppStore.getState().execution.activeTurnId).toBeUndefined()
    expect(useAppStore.getState().sessionSkills).toEqual([])
  })

  it("an older send response cannot erase a newer durable admission marker", async () => {
    const responses: ((value: {
      status: "accepted"
      turnId: string
    }) => void)[] = []
    const receipts: string[] = []
    request.mockImplementation(async (method, params) => {
      if (method === "engineSession/send") {
        receipts.push(params.requestId)
        return new Promise((resolve) => responses.push(resolve))
      }
      if (method === "engine/list") return { engines: [engine] }
      return {
        ...snapshot(),
        requests: receipts.map((requestId) => ({
          requestId,
          input: { requestId, text: "once" },
          status: "terminal",
          turnId: "finished",
        })),
      }
    })
    useEngineStore.setState({
      engineId: engine.id,
      sessionId: "external_session",
      snapshot: snapshot(),
    })
    const first = sendEngineInput("once")
    await selectEngineSession(snapshot().session)
    const second = sendEngineInput("twice")
    expect(receipts).toHaveLength(2)
    responses[0]?.({ status: "accepted", turnId: "first" })
    await first
    expect(
      localStorage.getItem("yakitori.enginePending:external_session"),
    ).toBe(receipts[1])
    responses[1]?.({ status: "accepted", turnId: "second" })
    await second
    expect(
      localStorage.getItem("yakitori.enginePending:external_session"),
    ).toBeNull()
  })

  it("does not send after an asynchronous create returns to an abandoned draft", async () => {
    let complete: ((value: EngineSessionSnapshot) => void) | undefined
    request.mockImplementation(
      () =>
        new Promise<EngineSessionSnapshot>((resolve) => {
          complete = resolve
        }),
    )
    chooseNewEngine("external")
    const pending = sendEngineInput("hello")
    chooseNewEngine("")
    complete?.(snapshot())
    await pending
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe("engineSession/create")
    expect(useEngineStore.getState().engineId).toBeUndefined()
  })

  it("retains an unknown send receipt and refuses an accidental duplicate", async () => {
    useEngineStore.setState({
      engineId: engine.id,
      sessionId: "external_session",
      snapshot: snapshot(),
    })
    request.mockImplementation(async (method) => {
      if (method === "engineSession/send") throw new Error("Connection lost")
      return snapshot()
    })
    await sendEngineInput("do once")
    expect(useEngineStore.getState().pendingRequestId).toMatch(/^request_/)
    await sendEngineInput("do once")
    expect(
      request.mock.calls.filter(([method]) => method === "engineSession/send"),
    ).toHaveLength(1)
    expect(
      localStorage.getItem("yakitori.enginePending:external_session"),
    ).toMatch(/^request_/)
  })
})
