import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { App } from "../../src/gui/app.tsx"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import { createEventEnvelope, EventType } from "../../src/kernel/events.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"
import type { InputDraft } from "../../src/protocol/user-input.ts"
import { pastePrompt } from "./prompt-editor-helpers.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"

const fake = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))
vi.mock("../../src/gui/lib/rpc-client.ts", async (original) => ({
  ...(await original<object>()),
  getAppRpcClient: () => fake.current,
}))
beforeEach(() => {
  fake.current = new FakeRpcClient()
})
afterEach(cleanup)

it.each([
  "composing",
  "committed",
])("keeps a %s edit attached through native creation and initial replay", async (editState) => {
  const session: ApiSessionDetail = {
    id: "session_first",
    conversationId: "conversation_first",
    title: "Untitled session",
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    seq: 1,
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      turns: 0,
      inputs: 0,
      tools: 0,
      pendingInputs: 0,
      items: 0,
      permissions: 0,
    },
  }
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  fake.current.respond = async (method) => {
    if (method === "session/create") {
      await pending
      return {
        session,
        event: createEventEnvelope({
          sessionId: session.id,
          seq: 1,
          event: { type: EventType.SessionCreated, data: {} },
        }),
      }
    }
    if (method === "session/queue/list") return { items: [] }
    throw new ApiRequestError("not found", "not_found")
  }
  const admitInput = vi.fn(async (_parts: InputDraft) => {})
  useAppStore.setState({ admitInput })
  render(<App />)
  fireEvent.click(screen.getByRole("button", { name: "New session" }))
  const editor = screen.getByRole("textbox", { name: "Message the Mate" })
  editor.focus()
  if (editState === "composing") {
    fireEvent.compositionStart(editor)
    const paragraph = editor.querySelector("p")
    if (!paragraph) throw new Error("Editor paragraph missing")
    paragraph.textContent = "Check"
  } else {
    await pastePrompt(editor, "Check the CI smoke flow.")
  }
  // A browser owns this editing target until composition/input completes. The
  // create response and replay must not replace it underneath that operation.
  await act(async () => release())
  if (editState === "composing") {
    // The browser delivers the rest of the edit to the original editing target.
    await act(async () => {
      const paragraph = editor.querySelector("p")
      if (!paragraph) throw new Error("Editor paragraph missing")
      paragraph.textContent = "Check the CI smoke flow."
      fireEvent.input(editor, { inputType: "insertCompositionText" })
    })
  }
  expect(
    screen.getByRole("textbox", { name: "Message the Mate" }).textContent,
  ).toBe("Check the CI smoke flow.")
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  const stream = fake.current.streams.at(-1)
  if (!stream) throw new Error("Session stream missing")
  act(() => stream.emitSnapshot({ session }))
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  // happy-dom cannot commit native input; use the real clipboard transaction.
  if (editState === "composing") {
    fireEvent.compositionEnd(editor)
    await pastePrompt(editor, "Check the CI smoke flow.", true)
  }
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  )
  fireEvent.keyDown(editor, { key: "Enter" })
  expect(admitInput).not.toHaveBeenCalled()
  act(() => stream.emitReplayComplete())
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  expect(document.activeElement).toBe(editor)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      false,
    ),
  )
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  expect(admitInput).toHaveBeenCalledTimes(1)
  expect(admitInput.mock.calls[0]?.[0]).toMatchObject({
    text: "Check the CI smoke flow.",
  })
  // An explicit new-session intent still owns a fresh editor and parks the
  // previous conversation's draft rather than leaking it into the new one.
  await act(async () => {
    useAppStore.getState().clearSessionSelection()
  })
  const next = screen.getByRole("textbox", { name: "Message the Mate" })
  expect(next).not.toBe(editor)
  expect(next.textContent).toBe("")
  expect(useAppStore.getState().sessionDrafts[session.id]?.content?.text).toBe(
    "Check the CI smoke flow.",
  )
})
