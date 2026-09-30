// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueuedInputs } from "../../src/gui/components/queued-inputs.tsx"
import { TooltipProvider } from "../../src/gui/components/ui/tooltip.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("queued inputs", () => {
  it("renders nothing while no input is queued", () => {
    useAppStore.setState({ queuedItems: [] })
    const { container } = render(
      <TooltipProvider>
        <QueuedInputs />
      </TooltipProvider>,
    )

    expect(container.firstChild).toBeNull()
  })

  it("lists the queued input text", () => {
    useAppStore.setState({ queuedItems: seedQueuedInput() })
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
      queuedItems: seedQueuedInput(),
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
      queuedItems: seedQueuedInput(),
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
  return [{
    id: "input_1",
    sessionId: "session_1",
    input: { submissionId: "request_1", content: { kind: "text" as const, text: "hello" } },
    createdAt: "2026-01-01T00:00:00.000Z",
  }]
}
