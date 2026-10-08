// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { QueuedInputs } from "../../src/gui/components/queued-inputs.tsx"
import { TooltipProvider } from "../../src/gui/components/ui/tooltip.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { textInputDraft } from "../../src/gui/input-draft.ts"
import { pastePrompt } from "./prompt-editor-helpers.ts"

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))

beforeEach(() => {
  request.mockReset()
  useAppStore.setState({
    ...createInitialAppState(),
    selection: { sessionId: "session_1" },
    queuedItems: [
      {
        id: "input_1",
        sessionId: "session_1",
        input: { submissionId: "request_1", content: textInputDraft("hello") },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
})
afterEach(cleanup)

it.each([
  "Save",
  "Enter",
])("retains a failed queued edit submitted by %s and closes after retry succeeds", async (gesture) => {
  const user = userEvent.setup()
  request.mockRejectedValue(new Error("Offline update failed"))
  render(
    <TooltipProvider>
      <QueuedInputs />
    </TooltipProvider>,
  )
  await user.click(screen.getByRole("button", { name: "Edit queued input" }))
  const editor = screen.getByRole("textbox", { name: "Edit queued input" })
  await pastePrompt(editor, " edited")
  if (gesture === "Save")
    await user.click(screen.getByRole("button", { name: "Save" }))
  else fireEvent.keyDown(editor, { key: "Enter" })
  await waitFor(() =>
    expect(useAppStore.getState().message).toBe("Offline update failed"),
  )
  expect(request.mock.calls[0]?.[0]).toBe("session/queue/update")
  expect(
    screen.getByRole("textbox", { name: "Edit queued input" }).textContent,
  ).toBe("hello edited")
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    false,
  )
  request.mockImplementation(async (method: string) =>
    method === "session/queue/list"
      ? {
          items: useAppStore
            .getState()
            .queuedItems.map((item) => ({
              ...item,
              input: { ...item.input, content: textInputDraft("hello edited") },
            })),
        }
      : {},
  )
  await user.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Edit queued input" }),
    ).toBeNull(),
  )
  expect(screen.getByText("hello edited")).toBeDefined()
})

it("a completed save cannot close a new edit opened after cancellation", async () => {
  const user = userEvent.setup()
  let finish: (() => void) | undefined
  request.mockImplementation(async (method: string) => {
    if (method === "session/queue/update")
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return method === "session/queue/list"
      ? { items: useAppStore.getState().queuedItems }
      : {}
  })
  render(
    <TooltipProvider>
      <QueuedInputs />
    </TooltipProvider>,
  )
  await user.click(screen.getByRole("button", { name: "Edit queued input" }))
  await pastePrompt(
    screen.getByRole("textbox", { name: "Edit queued input" }),
    " old",
  )
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    true,
  )
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  await user.click(screen.getByRole("button", { name: "Edit queued input" }))
  await pastePrompt(
    screen.getByRole("textbox", { name: "Edit queued input" }),
    " new",
  )
  await act(async () => {
    finish?.()
  })
  expect(
    screen.getByRole("textbox", { name: "Edit queued input" }).textContent,
  ).toBe("hello new")
})
