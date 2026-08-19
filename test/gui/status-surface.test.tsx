// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StatusSurface } from "../../src/gui/components/status-surface.tsx"
import { TooltipProvider } from "../../src/gui/components/ui/tooltip.tsx"
import {
  createExecutionViewState,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { createEventEnvelope, EventType, InputRole } from "../../src/index.ts"

const sessionId = "session_1"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("status surface", () => {
  it("labels an active turn as reasoning before response text arrives", () => {
    useAppStore.setState({ execution: seedActiveTurn() })
    render(
      <TooltipProvider>
        <StatusSurface />
      </TooltipProvider>,
    )

    expect(screen.getByText("Reasoning")).toBeDefined()
  })

  it("shows stopping after an interrupt request", () => {
    useAppStore.setState({
      execution: seedActiveTurn(),
      inFlightActions: new Set(["cancel:turn_1"]),
    })
    render(
      <TooltipProvider>
        <StatusSurface />
      </TooltipProvider>,
    )

    expect(screen.getByText("Stopping")).toBeDefined()
    expect(screen.getByRole("button", { name: /Stopping/ })).toHaveProperty(
      "disabled",
      true,
    )
  })

  it("routes queued-input cancel clicks through the store action", async () => {
    const user = userEvent.setup()
    const cancelQueuedInput = vi.fn((_inputId: string) => Promise.resolve())
    useAppStore.setState({
      execution: seedQueuedInput(),
      cancelQueuedInput,
    })
    render(
      <TooltipProvider>
        <StatusSurface />
      </TooltipProvider>,
    )

    await user.click(
      screen.getByRole("button", { name: "Cancel queued input" }),
    )
    expect(cancelQueuedInput).toHaveBeenCalledWith("input_1")
  })

  it("disables the cancel button while the cancel is in flight", () => {
    useAppStore.setState({
      execution: seedQueuedInput(),
      inFlightActions: new Set(["cancel-input:input_1"]),
    })
    render(
      <TooltipProvider>
        <StatusSurface />
      </TooltipProvider>,
    )

    expect(
      screen.getByRole("button", { name: "Cancel queued input" }),
    ).toHaveProperty("disabled", true)
  })
})

function seedQueuedInput() {
  return reduceExecutionView(createExecutionViewState(), {
    type: "durable",
    event: createEventEnvelope({
      sessionId,
      seq: 1,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text", text: "hello" },
        },
      },
    }),
  })
}

function seedActiveTurn() {
  let state = reduceExecutionView(createExecutionViewState(), {
    type: "durable",
    event: createEventEnvelope({
      sessionId,
      seq: 1,
      event: {
        type: EventType.TurnStarted,
        data: { turnId: "turn_1", inputId: "input_1" },
      },
    }),
  })
  state = reduceExecutionView(state, {
    type: "session",
    session: {
      id: sessionId,
      seq: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      activeTurnId: "turn_1",
      counts: {
        inputs: 1,
        pendingInputs: 0,
        turns: 1,
        items: 0,
        permissions: 0,
        tools: 0,
      },
    },
  })
  return state
}
