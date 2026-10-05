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
import { inputParts } from "./input-fixtures.ts"
import { pastePrompt } from "./prompt-editor-helpers.ts"

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

  it("preserves ordered images when reopening a canceled edit and saving new text", async () => {
    const user = userEvent.setup()
    const image = {
      type: "image" as const,
      name: "diagram.png",
      mediaType: "image/png" as const,
      sizeBytes: 9,
      file: { rolloutId: "session_1", path: "attachments/queued/diagram.png" },
    }
    const parts = [
      { type: "text" as const, text: "before" },
      image,
      { type: "text" as const, text: "after" },
    ]
    const updateQueuedInput = vi.fn(async () => {})
    const queuedItems = seedQueuedInput().map((item) => ({
      ...item,
      input: { ...item.input, content: { kind: "parts" as const, parts } },
    }))
    const originalQueuedItems = structuredClone(queuedItems)
    useAppStore.setState({ queuedItems, updateQueuedInput })
    render(
      <TooltipProvider>
        <QueuedInputs />
      </TooltipProvider>,
    )

    await user.click(screen.getByRole("button", { name: "Edit queued input" }))
    let editor = screen.getByRole("textbox", { name: "Edit queued input" })
    await pastePrompt(editor, "discarded ")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(updateQueuedInput).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("textbox", { name: "Edit queued input" }),
    ).toBeNull()

    await user.click(screen.getByRole("button", { name: "Edit queued input" }))
    editor = screen.getByRole("textbox", { name: "Edit queued input" })
    expect(editor.textContent).not.toContain("discarded")
    await pastePrompt(editor, " updated")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(updateQueuedInput).toHaveBeenCalledExactlyOnceWith("input_1", [
      { type: "text", text: "before" },
      image,
      { type: "text", text: "after updated" },
    ])
    expect(useAppStore.getState().queuedItems).toEqual(originalQueuedItems)
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
  return [
    {
      id: "input_1",
      sessionId: "session_1",
      input: {
        submissionId: "request_1",
        content: { kind: "parts" as const, parts: inputParts("hello") },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]
}
