// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createEventEnvelope, EventType, InputRole } from "../../src/index.ts"
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

const sessionId = "session_1"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("status surface", () => {
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
