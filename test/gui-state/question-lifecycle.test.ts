import "./setup-store-environment.ts"
import { beforeEach, expect, it, vi } from "vitest"
import { textInputDraft } from "../../src/gui/input-draft.ts"
import { inputRecoveryMemory } from "../../src/gui/input-recovery-memory.ts"
import { questionAnswerMemory } from "../../src/gui/question-answer-memory.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  clearThreadScopes,
  readThreadScopeValue,
  writeThreadScopeValue,
} from "../../src/gui/store/thread-scope-store.ts"
import { createEventEnvelope } from "../../src/kernel/events.ts"
import type { ApiSessionDetail } from "../../src/protocol/application.ts"
import { inputContent } from "../../src/protocol/user-input.ts"
import { FakeRpcClient } from "../gui/fake-rpc-client.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))
vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => fakeRef.current,
}))

const session: ApiSessionDetail = {
  id: "session_questions",
  rolloutId: "rollout_questions",
  conversationId: "session_questions",
  seq: 0,
  createdAt: "2026-11-16T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
  active: true,
  activeTurnId: "turn_questions",
  pendingInputs: [],
  pendingPermissions: [],
  counts: {
    inputs: 1,
    pendingInputs: 0,
    turns: 1,
    items: 0,
    permissions: 0,
    tools: 0,
  },
}

function question(seq: number, toolCallId = "ask_where") {
  return createEventEnvelope({
    sessionId: session.id,
    seq,
    event: {
      type: "item.completed",
      data: {
        turnId: "turn_questions",
        item: {
          type: "dynamic_tool_call",
          itemId: `item_${toolCallId}`,
          toolCallId,
          name: "request_user_input_async",
          input: {},
          requiresPermission: false,
          resultItemId: `result_${toolCallId}`,
          content: { kind: "text", text: "Questions presented" },
          output: {
            kind: "user_questions",
            questions: [{ title: "Where?" }, { title: "Optional detail?" }],
          },
        },
      },
    },
  })
}

function completed(
  seq: number,
  status: "completed" | "failed" | "interrupted",
) {
  return createEventEnvelope({
    sessionId: session.id,
    seq,
    event: {
      type: "turn.completed",
      data: {
        turnId: "turn_questions",
        outcome:
          status === "failed"
            ? { status, error: { code: "internal_error", message: "Failed" } }
            : { status },
      },
    },
  })
}

async function open() {
  await useAppStore.getState().selectSession(session.id)
  const stream = fakeRef.current.streams.at(-1)
  if (stream === undefined) throw new Error("Missing stream")
  stream.emitSnapshot({ session })
  stream.emitReplayComplete()
  return stream
}

beforeEach(() => {
  localStorage.clear()
  clearThreadScopes()
  inputRecoveryMemory.clear()
  questionAnswerMemory.clear()
  fakeRef.current = new FakeRpcClient()
  useAppStore.setState(
    { ...useAppStore.getInitialState(), ...createInitialAppState() },
    true,
  )
  useAppStore.setState({ apiBase: "http://questions.test" })
})

it.each([
  "completed",
  "failed",
  "interrupted",
] as const)("recovers only unsent typed answers once after %s, preserving the existing draft", async (status) => {
  const stream = await open()
  stream.emitEvent(question(1))
  stream.emitEvent(question(2, "ask_sent"))
  writeThreadScopeValue(session.id, "questions:ask_where:answers", [
    "  Downloads  ",
    "",
  ])
  writeThreadScopeValue(session.id, "questions:ask_sent:answers", [
    "Already sent",
    "",
  ])
  questionAnswerMemory.reserve(
    "http://questions.test",
    session.id,
    "ask_sent",
    ["Already sent", ""],
  )
  const draft = {
    ...textInputDraft("Existing draft"),
    attachments: [
      {
        name: "image.png",
        mediaType: "image/png" as const,
        sizeBytes: 4,
        file: { url: "https://example.com/image.png" },
      },
    ],
  }
  useAppStore.getState().setPromptDraft(draft)
  stream.emitEvent(completed(3, status))
  stream.emitEvent(completed(3, status))
  expect(useAppStore.getState().execution.pendingQuestionIds).toEqual([])
  expect(useAppStore.getState().promptDraft).toEqual(draft)
  expect(useAppStore.getState().promptExcerpts).toMatchObject([
    {
      text: "Where?",
      comment: "Downloads",
      source: {
        kind: "message",
        label: "Question",
        sessionId: session.id,
        messageId: "item_ask_where",
      },
    },
  ])
  expect(
    fakeRef.current.requests.filter(
      ({ method }) =>
        method.startsWith("session/input") ||
        method === "session/question/answer",
    ),
  ).toEqual([])
})

it("recovers after a transient terminal notice without duplicating on durable completion", async () => {
  const stream = await open()
  stream.emitEvent(question(1))
  writeThreadScopeValue(session.id, "questions:ask_where:answers", [
    "Workspace",
  ])
  stream.emitTransient({
    type: "turn.finished",
    sessionId: session.id,
    turnId: "turn_questions",
    outcome: { status: "interrupted" },
    createdAt: session.createdAt,
  })
  stream.emitEvent(completed(2, "interrupted"))
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(useAppStore.getState().promptExcerpts).toMatchObject([
    { text: "Where?", comment: "Workspace" },
  ])
})

it.each([
  true,
  false,
])("recovers resident drafts on idle reconnect (terminal event present: %s) without activating historical questions", async (hasTerminalEvent) => {
  const stream = await open()
  stream.emitEvent(question(1))
  writeThreadScopeValue(session.id, "questions:ask_where:answers", [
    "Workspace",
  ])
  stream.disconnect(new Error("Disconnected"))
  const { activeTurnId: _, ...idle } = session
  stream.emitSnapshot({ session: { ...idle, active: false, seq: 3 } })
  stream.emitEvent(question(2, "historical_question"))
  if (hasTerminalEvent) stream.emitEvent(completed(3, "completed"))
  stream.emitReplayComplete()
  expect(useAppStore.getState().execution.pendingQuestionIds).toEqual([])
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(useAppStore.getState().promptExcerpts).toMatchObject([
    { text: "Where?", comment: "Workspace" },
  ])
})

it("does not recover skipped answers at turn end", async () => {
  const stream = await open()
  stream.emitEvent(question(1))
  writeThreadScopeValue(session.id, "questions:ask_where:answers", [
    "Discard me",
  ])
  useAppStore.getState().dismissQuestions("ask_where")
  stream.emitEvent(completed(2, "completed"))
  expect(useAppStore.getState().execution.pendingQuestionIds).toEqual([])
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(useAppStore.getState().promptExcerpts).toEqual([])
})

it("clears questions when an ordinary queued message is accepted", async () => {
  const stream = await open()
  stream.emitEvent(question(1))
  stream.emitEvent(question(2, "ask_sent"))
  writeThreadScopeValue(session.id, "questions:ask_where:answers", [
    "Discard me",
  ])
  writeThreadScopeValue(session.id, "questions:ask_sent:answers", [
    "Already sent",
  ])
  questionAnswerMemory.reserve(
    "http://questions.test",
    session.id,
    "ask_sent",
    ["Already sent"],
  )
  fakeRef.current.respond = (method, params) => {
    if (method === "session/input/queue") {
      const input = params as { requestId: string }
      return {
        sessionId: session.id,
        turnId: "queued_turn",
        inputId: "queued_input",
        requestId: input.requestId,
        content: inputContent(textInputDraft("Continue")),
      }
    }
    if (method === "session/queue/list") return { items: [] }
    throw new Error(`Unexpected request: ${method}`)
  }
  await useAppStore.getState().admitInput(textInputDraft("Continue"), "queue")
  expect(useAppStore.getState().execution.pendingQuestionIds).toEqual([])
  expect(
    readThreadScopeValue(session.id, "questions:ask_sent:answers", []),
  ).toEqual(["Already sent"])
  stream.emitEvent(completed(3, "completed"))
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(useAppStore.getState().promptExcerpts).toEqual([])
})

it("keeps questions asked after an ordinary input when its RPC response arrives late", async () => {
  const stream = await open()
  stream.emitEvent(question(1))
  const response = Promise.withResolvers<unknown>()
  let requestId = ""
  fakeRef.current.respond = (method, params) => {
    if (method === "session/input") {
      requestId = (params as { requestId: string }).requestId
      return response.promise
    }
    if (method === "session/queue/list") return { items: [] }
    throw new Error(`Unexpected request: ${method}`)
  }
  const content = inputContent(textInputDraft("Continue"))
  const submitting = useAppStore
    .getState()
    .admitInput(textInputDraft("Continue"))
  await vi.waitFor(() => expect(requestId).not.toBe(""))
  stream.emitEvent(
    createEventEnvelope({
      sessionId: session.id,
      seq: 2,
      event: {
        type: "input.admitted",
        data: {
          inputId: "followup",
          requestId,
          role: "user",
          content,
          steered: true,
        },
      },
    }),
  )
  stream.emitEvent(question(3, "ask_new"))
  response.resolve({ requestId, turnId: "turn_questions", content })
  await submitting
  expect(useAppStore.getState().execution.pendingQuestionIds).toEqual([
    "ask_new",
  ])
})

it("recovers a rejected closed answer once after its outbox is released", async () => {
  const stream = await open()
  stream.emitEvent(question(1))
  writeThreadScopeValue(session.id, "questions:ask_where:answers", [
    "Workspace",
  ])
  questionAnswerMemory.reserve(
    "http://questions.test",
    session.id,
    "ask_where",
    ["Workspace"],
  )
  stream.emitEvent(completed(2, "completed"))
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  questionAnswerMemory.acknowledge(
    "http://questions.test",
    session.id,
    "ask_where",
  )
  useAppStore.getState().restoreQuestionDraft(session.id, "ask_where")
  useAppStore.getState().restoreQuestionDraft(session.id, "ask_where")
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(useAppStore.getState().promptExcerpts).toMatchObject([
    { text: "Where?", comment: "Workspace" },
  ])
})

it("sends recovered question answers as editable annotations alongside existing references", async () => {
  const stream = await open()
  const existing = {
    id: "existing_reference",
    text: "Existing excerpt",
    source: { kind: "file" as const, label: "Notes", path: "/notes.md" },
  }
  useAppStore.getState().addPromptExcerpt(existing)
  useAppStore.getState().setPromptDraft(textInputDraft("Follow-up"))
  stream.emitEvent(question(1))
  writeThreadScopeValue(session.id, "questions:ask_where:answers", [
    "Workspace",
    "Use the current folder",
  ])
  stream.emitEvent(completed(2, "completed"))
  expect(
    await useAppStore.getState().loadHistoryThrough("item_ask_where"),
  ).toBe(true)
  const excerpts = useAppStore.getState().promptExcerpts
  expect(excerpts).toMatchObject([
    existing,
    { text: "Where?", comment: "Workspace" },
    { text: "Optional detail?", comment: "Use the current folder" },
  ])
  const questionExcerpt = excerpts[1]
  if (questionExcerpt === undefined)
    throw new Error("Missing question reference")
  useAppStore
    .getState()
    .updatePromptExcerpt({ ...questionExcerpt, comment: "Downloads instead" })
  fakeRef.current.respond = (method, params) => {
    if (method === "session/input") {
      const input = params as { requestId: string; content: unknown }
      return {
        requestId: input.requestId,
        turnId: "followup_turn",
        content: input.content,
      }
    }
    if (method === "session/queue/list") return { items: [] }
    throw new Error(`Unexpected request: ${method}`)
  }
  await useAppStore.getState().admitInput(textInputDraft("Follow-up"))
  const sent = fakeRef.current.requestsFor("session/input")[0]?.params as {
    content: { text: string; references: unknown[] }
  }
  expect(sent.content.text).toBe("Follow-up")
  expect(sent.content.references).toMatchObject([
    existing,
    { text: "Where?", comment: "Downloads instead" },
    { text: "Optional detail?", comment: "Use the current folder" },
  ])
})
