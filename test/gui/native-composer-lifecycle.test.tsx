import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { App } from "../../src/gui/app.tsx"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import {
  createEventEnvelope,
  EventType,
  InputRole,
} from "../../src/kernel/events.ts"
import type { ApiAdmitInputRequest } from "../../src/protocol/application.ts"
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
  rolloutId: "rollout_first",
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

it("keeps an unallocated native draft and its quotes when switching engines", async () => {
  const { chooseNewEngine } = await import(
    "../../src/gui/store/engine-store.ts"
  )
  useAppStore.getState().setPromptDraft({
    kind: "input",
    text: "Keep the native draft",
    attachments: [],
    elements: [],
  })
  useAppStore.getState().addPromptExcerpt({
    id: "quote_native",
    text: "Quoted passage",
    source: {
      kind: "message",
      label: "Assistant message",
      sessionId: "earlier",
      messageId: "answer",
    },
  })
  chooseNewEngine("external")
  chooseNewEngine("")
  expect(useAppStore.getState().promptDraft?.text).toBe("Keep the native draft")
  expect(useAppStore.getState().promptExcerpts).toMatchObject([
    { id: "quote_native", text: "Quoted passage" },
  ])
})

it.each([
  "composing",
  "committed",
])("keeps a %s local edit in the same editor through first send and replay", async (editState) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let releaseInput!: () => void
  const pendingInput = new Promise<void>((resolve) => {
    releaseInput = resolve
  })
  fake.current.respond = async (method, params) => {
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
    if (method === "session/input") {
      await pendingInput
      const { requestId, content } = params as ApiAdmitInputRequest
      return { requestId, content, turnId: "turn_first" }
    }
    if (method === "session/queue/list") return { items: [] }
    throw new ApiRequestError("not found", "not_found")
  }
  render(<App />)
  fireEvent.click(screen.getByRole("button", { name: "New session" }))
  const editor = screen.getByRole("textbox", { name: "Message the Mate" })
  await pastePrompt(editor, "Check")
  editor.focus()
  if (editState === "composing") {
    fireEvent.compositionStart(editor)
    const paragraph = editor.querySelector("p")
    if (!paragraph) throw new Error("Editor paragraph missing")
    paragraph.textContent = "Check"
  } else {
    await pastePrompt(editor, "Check the CI smoke flow.", true)
  }
  fireEvent.click(screen.getByRole("button", { name: "New session" }))
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  expect(editor.textContent).toBe(
    editState === "composing" ? "Check" : "Check the CI smoke flow.",
  )
  expect(fake.current.requestsFor("session/create")).toHaveLength(0)
  expect(fake.current.streams).toHaveLength(0)
  expect(useAppStore.getState().selection.sessionId).toBeUndefined()
  if (editState === "composing") {
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true })
    expect(fake.current.requestsFor("session/create")).toHaveLength(0)
    // The browser delivers the rest of the edit to the original editing target.
    await act(async () => {
      const paragraph = editor.querySelector("p")
      if (!paragraph) throw new Error("Editor paragraph missing")
      paragraph.textContent = "Check the CI smoke flow."
      fireEvent.input(editor, { inputType: "insertCompositionText" })
    })
    // happy-dom cannot commit native input; use the real clipboard transaction.
    fireEvent.compositionEnd(editor)
    await pastePrompt(editor, "Check the CI smoke flow.", true)
  }
  expect(
    screen.getByRole("textbox", { name: "Message the Mate" }).textContent,
  ).toBe("Check the CI smoke flow.")
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  expect(fake.current.requestsFor("session/create")).toHaveLength(1)
  expect(fake.current.requestsFor("session/input")).toHaveLength(0)
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  await act(async () => release())
  expect(fake.current.requestsFor("session/input")).toHaveLength(1)
  expect(fake.current.requestsFor("session/input")[0]?.params).toMatchObject({
    sessionId: session.id,
    content: { text: "Check the CI smoke flow." },
  })
  const stream = fake.current.streams.at(-1)
  if (!stream) throw new Error("Session stream missing")
  act(() => stream.emitSnapshot({ session }))
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  expect(screen.getByRole("button", { name: "Sending" })).toHaveProperty(
    "disabled",
    true,
  )
  fireEvent.keyDown(editor, { key: "Enter" })
  expect(fake.current.requestsFor("session/input")).toHaveLength(1)
  act(() => stream.emitReplayComplete())
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  expect(document.activeElement).toBe(editor)
  await act(async () => releaseInput())
  expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(editor)
  expect(editor.textContent).toBe("")
  expect(fake.current.requestsFor("session/create")).toHaveLength(1)
  expect(fake.current.requestsFor("session/input")).toHaveLength(1)
  await pastePrompt(editor, "The next task")
  // An explicit new-session intent still owns a fresh editor and parks the
  // previous conversation's draft rather than leaking it into the new one.
  await act(async () => {
    useAppStore.getState().clearSessionSelection()
  })
  const next = screen.getByRole("textbox", { name: "Message the Mate" })
  expect(next).not.toBe(editor)
  expect(next.textContent).toBe("")
  expect(useAppStore.getState().sessionDrafts[session.id]?.content?.text).toBe(
    "The next task",
  )
})

it("keeps the welcome layout for a local draft until its first send creates the conversation", async () => {
  const projectSession = {
    ...session,
    projectId: "project_default",
    workingDirectory: "/default",
  }
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let releaseInput!: () => void
  const pendingInput = new Promise<void>((resolve) => {
    releaseInput = resolve
  })
  fake.current.respond = async (method, params) => {
    if (method === "session/create") {
      await pending
      return {
        session: projectSession,
        event: createEventEnvelope({
          sessionId: session.id,
          seq: 1,
          event: { type: EventType.SessionCreated, data: {} },
        }),
      }
    }
    if (method === "session/input") {
      await pendingInput
      const { requestId, content } = params as ApiAdmitInputRequest
      return { requestId, content, turnId: "turn_first" }
    }
    throw new ApiRequestError("not found", "not_found")
  }
  render(<App />)
  fireEvent.click(screen.getByRole("button", { name: "New session" }))
  const editor = screen.getByRole("textbox", { name: "Message the Mate" })
  const surface = editor.closest(".conversation-surface")
  const expectWelcomeLayout = (heading = "What would you like to work on?") => {
    expect(surface?.getAttribute("data-empty")).toBe("true")
    expect(
      screen.getByRole("heading", {
        name: heading,
      }),
    ).toBeDefined()
    expect(
      screen.queryByRole("heading", { name: "Untitled session" }),
    ).toBeNull()
    expect(screen.getByRole("textbox", { name: "Message the Mate" })).toBe(
      editor,
    )
  }
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
  expectWelcomeLayout("What would you like to build in Default project?")
  expect(
    screen.getByRole("combobox", { name: "New session project" }),
  ).toHaveProperty("disabled", false)
  expect(
    screen.getByRole("combobox", { name: "New session project" }).textContent,
  ).toBe("Default project")
  await pastePrompt(editor, "Begin")
  expectWelcomeLayout("What would you like to build in Default project?")
  expect(fake.current.requestsFor("session/create")).toHaveLength(0)
  expect(fake.current.streams).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  expect(fake.current.requestsFor("session/create")).toHaveLength(1)
  expect(fake.current.requestsFor("session/create")[0]?.params).toEqual({
    projectId: "project_default",
    workingDirectory: "/default",
  })
  expect(fake.current.requestsFor("session/input")).toHaveLength(0)
  expectWelcomeLayout("What would you like to build in Default project?")
  await act(async () => release())
  expect(fake.current.requestsFor("session/input")).toHaveLength(1)
  expect(surface?.hasAttribute("data-empty")).toBe(false)
  expect(
    screen.getByRole("heading", { name: "Untitled session" }),
  ).toBeDefined()
  expect(
    screen.queryByRole("combobox", { name: "New session project" }),
  ).toBeNull()
  const stream = fake.current.streams.at(-1)
  if (!stream) throw new Error("Session stream missing")
  act(() => stream.emitSnapshot({ session: projectSession }))
  expect(surface?.hasAttribute("data-empty")).toBe(false)
  act(() => stream.emitReplayComplete())
  expect(surface?.hasAttribute("data-empty")).toBe(false)
  const input = fake.current.requestsFor("session/input")[0]
    ?.params as ApiAdmitInputRequest
  act(() =>
    stream.emitEvent(
      createEventEnvelope({
        sessionId: session.id,
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: input.requestId,
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
  await act(async () => releaseInput())
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
