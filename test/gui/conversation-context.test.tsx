// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Composer } from "../../src/gui/components/composer.tsx"
import type {
  ContextExcerpt,
  ResponseAnnotation,
} from "../../src/gui/conversation-context.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  createEventEnvelope,
  EventType,
  InputRole,
} from "../../src/kernel/events.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))
vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => fakeRef.current,
}))

const excerpt: ResponseAnnotation = {
  id: "excerpt-first",
  kind: "annotation",
  text: "const result = await run()",
  comment: "Check the error handling.",
  anchor: { startOffset: 0, endOffset: 25 },
  source: {
    kind: "file",
    label: "main.ts",
    path: "/repo/main.ts",
    sessionId: "session_1",
  },
}

beforeEach(() => {
  window.localStorage.clear()
  fakeRef.current = new FakeRpcClient()
  fakeRef.current.respond = (method) => {
    if (method === "session/skills") return { skills: [] }
    if (method === "session/list") return { sessions: [] }
    throw new ApiRequestError("Unavailable", "not_found")
  }
  useAppStore.setState({
    ...createInitialAppState(),
    selection: { sessionId: "session_1" },
    apiBase: "http://api.test",
    promptDraft: "Please review",
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(createInitialAppState())
})

function holdAdmission() {
  let resolve!: (value: unknown) => void
  let reject!: (cause: unknown) => void
  const pending = new Promise<unknown>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  const fallback = fakeRef.current.respond
  fakeRef.current.respond = (method, params) =>
    method === "session/input" ? pending : fallback(method, params)
  return {
    reject,
    acknowledge() {
      const body = fakeRef.current.requestsFor("session/input")[0]?.params as {
        sessionId: string
        requestId: string
        content: {
          kind: "text"
          text: string
          contextAttachments?: readonly ContextExcerpt[]
        }
      }
      resolve({
        requestId: body.requestId,
        inputId: "input_1",
        event: createEventEnvelope({
          sessionId: body.sessionId,
          seq: 2,
          event: {
            type: EventType.InputAdmitted,
            data: {
              requestId: body.requestId,
              inputId: "input_1",
              role: InputRole.User,
              content: body.content,
            },
          },
        }),
      })
    },
  }
}

it("sends excerpt text, comments, and source metadata, clearing the original draft only after acknowledgement", async () => {
  const held = holdAdmission()
  useAppStore.getState().addPromptExcerpt(excerpt)
  const user = userEvent.setup()
  render(<Composer />)
  expect(screen.getByRole("button", { name: "1 annotation" })).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Send" }))
  await waitFor(() =>
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1),
  )
  expect(fakeRef.current.requestsFor("session/input")[0]?.params).toMatchObject(
    {
      sessionId: "session_1",
      content: {
        kind: "text",
        text: "Please review",
        contextAttachments: [excerpt],
      },
    },
  )
  expect(useAppStore.getState().promptDraft).toBe("Please review")
  expect(screen.getByRole("button", { name: "1 annotation" })).toBeDefined()
  await act(async () => held.acknowledge())
  await waitFor(() =>
    expect(useAppStore.getState().promptDraft).toBeUndefined(),
  )
  expect(useAppStore.getState().promptExcerpts).toEqual([])
  expect(screen.queryByRole("button", { name: "1 annotation" })).toBeNull()
})

it("retains the draft and annotations when admission fails", async () => {
  const held = holdAdmission()
  useAppStore.getState().addPromptExcerpt(excerpt)
  const sending = useAppStore.getState().admitInput("Please review")
  await waitFor(() =>
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1),
  )
  held.reject(new ApiRequestError("Connection lost", "not_found"))
  await sending
  expect(useAppStore.getState().promptDraft).toBe("Please review")
  expect(useAppStore.getState().promptExcerpts).toEqual([excerpt])
})

it("preserves annotations edited or added while the submitted snapshot is pending", async () => {
  const held = holdAdmission()
  useAppStore.getState().addPromptExcerpt(excerpt)
  const sending = useAppStore.getState().admitInput("Please review")
  await waitFor(() =>
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1),
  )
  useAppStore
    .getState()
    .updatePromptExcerpt({ ...excerpt, comment: "A revised comment" })
  const later = { ...excerpt, id: "excerpt-later", text: "Additional context" }
  useAppStore.getState().addPromptExcerpt(later)
  held.acknowledge()
  await sending
  expect(useAppStore.getState().promptExcerpts).toEqual([
    { ...excerpt, comment: "A revised comment" },
    later,
  ])
})

it("keeps annotations with their session when another session is selected during admission", async () => {
  const held = holdAdmission()
  useAppStore.getState().addPromptExcerpt(excerpt)
  const sending = useAppStore.getState().admitInput("Please review")
  await waitFor(() =>
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1),
  )
  await useAppStore.getState().selectSession("session_2")
  expect(useAppStore.getState().promptExcerpts).toEqual([])
  const second = {
    ...excerpt,
    id: "excerpt-second",
    text: "Another session's draft",
  }
  useAppStore.getState().addPromptExcerpt(second)
  held.acknowledge()
  await sending
  expect(useAppStore.getState().promptExcerpts).toEqual([second])
  await useAppStore.getState().selectSession("session_1")
  expect(useAppStore.getState().promptExcerpts).toEqual([excerpt])
})

it("lets the composer preview and remove annotations without expanding an inline inspector", async () => {
  useAppStore.setState({ promptDraft: undefined })
  useAppStore.getState().addPromptExcerpt({ ...excerpt, comment: "" })
  const user = userEvent.setup()
  render(<Composer />)
  expect(
    (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false)
  await user.click(screen.getByRole("button", { name: "1 annotation" }))
  expect(screen.getByText("const result = await run()")).toBeDefined()
  expect(
    screen.queryByRole("textbox", { name: "Annotation comment (optional)" }),
  ).toBeNull()
  expect(
    screen.getByRole("button", { name: "Edit annotation 1" }),
  ).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Remove annotation 1" }))
  expect(
    (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  expect(useAppStore.getState().promptExcerpts).toEqual([])
})

it("keeps new-conversation excerpts separate and carries them through the first admission", async () => {
  useAppStore.getState().addPromptExcerpt(excerpt)
  useAppStore.getState().startNewSession()
  const newExcerpt = {
    ...excerpt,
    id: "excerpt-new",
    text: "A new task's context",
  }
  useAppStore.getState().addPromptExcerpt(newExcerpt)
  await useAppStore.getState().selectSession("session_1")
  expect(useAppStore.getState().promptExcerpts).toEqual([excerpt])
  useAppStore.getState().startNewSession()
  expect(useAppStore.getState().promptExcerpts).toEqual([newExcerpt])

  const fallback = fakeRef.current.respond
  fakeRef.current.respond = (method, params) =>
    method === "session/create"
      ? {
          session: {
            id: "session_created",
            conversationId: "conversation_created",
            seq: 1,
            createdAt: "2026-09-19T00:00:00Z",
            updatedAt: "2026-09-19T00:00:00Z",
            pendingInputs: [],
            pendingPermissions: [],
            counts: {
              inputs: 0,
              pendingInputs: 0,
              turns: 0,
              items: 0,
              permissions: 0,
              tools: 0,
            },
          },
          event: createEventEnvelope({
            sessionId: "session_created",
            seq: 1,
            event: { type: EventType.SessionCreated, data: {} },
          }),
        }
      : fallback(method, params)
  const held = holdAdmission()
  const sending = useAppStore.getState().admitInput("")
  await waitFor(() =>
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1),
  )
  expect(fakeRef.current.requestsFor("session/input")[0]?.params).toMatchObject(
    {
      sessionId: "session_created",
      content: { text: "", contextAttachments: [newExcerpt] },
    },
  )
  expect(useAppStore.getState().promptExcerpts).toEqual([newExcerpt])
  held.acknowledge()
  await sending
  expect(useAppStore.getState().promptExcerpts).toEqual([])
  await useAppStore.getState().selectSession("session_1")
  expect(useAppStore.getState().promptExcerpts).toEqual([excerpt])
})
