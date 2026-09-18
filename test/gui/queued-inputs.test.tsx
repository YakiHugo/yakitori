// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueuedInputs } from "../../src/gui/components/queued-inputs.tsx"
import { TooltipProvider } from "../../src/gui/components/ui/tooltip.tsx"
import {
  createExecutionViewState,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  createEventEnvelope,
  EventType,
  InputRole,
} from "../../src/kernel/events.ts"

const sessionId = "session_1"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("queued inputs", () => {
  it("renders nothing while no input is queued", () => {
    useAppStore.setState({ execution: createExecutionViewState() })
    const { container } = render(
      <TooltipProvider>
        <QueuedInputs />
      </TooltipProvider>,
    )

    expect(container.firstChild).toBeNull()
  })

  it("lists the queued input text", () => {
    useAppStore.setState({ execution: seedQueuedInput() })
    render(
      <TooltipProvider>
        <QueuedInputs />
      </TooltipProvider>,
    )

    expect(screen.getByText("queued")).toBeDefined()
    expect(screen.getByText("hello")).toBeDefined()
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
        <QueuedInputs />
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
        <QueuedInputs />
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
