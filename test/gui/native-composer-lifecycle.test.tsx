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
import {
  createEventEnvelope,
  EventType,
  InputRole,
} from "../../src/kernel/events.ts"
import type { InputDraft } from "../../src/protocol/user-input.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"
import { pastePrompt } from "./prompt-editor-helpers.ts"

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

it.each([
  "composing",
  "committed",
])("keeps a %s edit attached through native creation and initial replay", async (editState) => {
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

it("keeps the welcome layout through empty session creation and replay until input arrives", async () => {
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
    throw new ApiRequestError("not found", "not_found")
  }
  render(<App />)
  fireEvent.click(screen.getByRole("button", { name: "New session" }))
  const editor = screen.getByRole("textbox", { name: "Message the Mate" })
  const surface = editor.closest(".conversation-surface")
  const expectWelcomeLayout = () => {
    expect(surface?.getAttribute("data-empty")).toBe("true")
    expect(
      screen.getByRole("heading", { name: "What would you like to work on?" }),
    ).toBeDefined()
    expect(
      screen.queryByRole("heading", { name: "Untitled session" }),
    ).toBeNull()
    expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(
      editor,
    )
  }
  expectWelcomeLayout()
  await act(async () => release())
  expectWelcomeLayout()
  act(() =>
    useAppStore.setState({
      currentProject: "project_default",
      projects: [
        {
          id: "project_default",
          name: "Default project",
          roots: ["/default"],
          metadata: {},
          position: 0,
          pinned: false,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }),
  )
  expectWelcomeLayout()
  expect(
    screen.getByRole("combobox", { name: "New session project" }),
  ).toHaveProperty("disabled", true)
  expect(
    screen.getByRole("combobox", { name: "New session project" }).textContent,
  ).toBe("No project")
  const stream = fake.current.streams.at(-1)
  if (!stream) throw new Error("Session stream missing")
  act(() => stream.emitSnapshot({ session }))
  expectWelcomeLayout()
  act(() => stream.emitReplayComplete())
  expectWelcomeLayout()
  act(() =>
    stream.emitEvent(
      createEventEnvelope({
        sessionId: session.id,
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request_first",
            inputId: "input_first",
            role: InputRole.User,
            content: {
              kind: "input",
              text: "Begin",
              elements: [],
              attachments: [],
            },
          },
        },
      }),
    ),
  )
  expect(surface?.hasAttribute("data-empty")).toBe(false)
  expect(
    screen.getByRole("heading", { name: "Untitled session" }),
  ).toBeDefined()
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
})

it("keeps a populated session docked while its snapshot awaits history replay", async () => {
  render(<App />)
  await act(async () => useAppStore.getState().selectSession(session.id))
  const stream = fake.current.streams.at(-1)
  if (!stream) throw new Error("Session stream missing")
  const editor = screen.getByRole("textbox", { name: "Message the Mate" })
  const surface = editor.closest(".conversation-surface")
  expect(surface?.hasAttribute("data-empty")).toBe(false)
  act(() =>
    stream.emitSnapshot({
      session: { ...session, counts: { ...session.counts, inputs: 1 } },
    }),
  )
  expect(surface?.hasAttribute("data-empty")).toBe(false)
  expect(screen.getByRole("status").textContent).toBe("Loading conversation…")
})
