// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  PlanCell,
  UserQuestionsCell,
} from "../../src/gui/components/cells/session-progress-cell.tsx"
import { ToolCell } from "../../src/gui/components/cells/tool-cell.tsx"
import { createExecutionViewState } from "../../src/gui/execution-view.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import { questionAnswerMemory } from "../../src/gui/question-answer-memory.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import { clearThreadScopes } from "../../src/gui/store/thread-scope-store.ts"
import { inputParts } from "./input-fixtures.ts"

const request = vi.hoisted(() => vi.fn())
vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => ({ request }),
}))
beforeEach(() => {
  questionAnswerMemory.clear()
  clearThreadScopes()
  useAppStore.setState({ execution: createExecutionViewState() })
})
afterEach(() => {
  cleanup()
  request.mockReset()
})

it.each([
  undefined,
  "session_context",
])("uses the question transcript item as a context source for session %s", (sessionId) => {
  useAppStore.setState({
    selection: sessionId === undefined ? {} : { sessionId },
  })
  render(
    <ToolCell
      entry={{
        kind: "tool",
        toolCallId: "call_question_source",
        turnId: "turn_question_source",
        execution: {
          type: "dynamic_tool_call",
          itemId: "item_question_source",
          toolCallId: "call_question_source",
          name: "request_user_input_async",
          input: {},
          requiresPermission: false,
        },
        state: "completed",
        output: { questions: [{ title: "Destination?" }] },
      }}
    />,
  )
  const card = screen.getByRole("form", { name: "Questions from your Mate" })
  if (sessionId === undefined) {
    expect(card.hasAttribute("data-context-kind")).toBe(false)
    expect(card.hasAttribute("data-context-message-id")).toBe(false)
  } else {
    expect(card.getAttribute("data-context-kind")).toBe("message")
    expect(card.getAttribute("data-context-session-id")).toBe("session_context")
    expect(card.getAttribute("data-context-message-id")).toBe(
      "item_question_source",
    )
    expect(card.getAttribute("data-context-label")).toBe("Question")
  }
})

it("retries the same correlated answer and waits for durable confirmation", async () => {
  useAppStore.setState({
    selection: {
      ...useAppStore.getState().selection,
      sessionId: "session_questions",
    },
    execution: {
      ...createExecutionViewState(),
      pendingQuestionIds: ["ask_1"],
    },
  })
  request
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce({})
  const user = userEvent.setup()
  render(
    <UserQuestionsCell
      toolCallId="ask_1"
      itemId="item_ask_1"
      request={{
        kind: "user_questions",
        questions: [
          { title: "Destination?", options: ["Workspace", "Downloads"] },
        ],
      }}
    />,
  )
  await user.type(
    screen.getByRole("combobox", { name: "Destination?" }),
    "Custom directory",
  )
  await user.click(screen.getByRole("button", { name: "Send answers" }))
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Disconnected",
  )
  expect(screen.getByRole("combobox", { name: "Destination?" })).toHaveProperty(
    "disabled",
    true,
  )
  expect(screen.getByRole("button", { name: "Skip questions" })).toHaveProperty(
    "disabled",
    true,
  )
  await user.click(screen.getByRole("button", { name: "Retry same answers" }))
  expect(
    await screen.findByText("Answers received; waiting for confirmation."),
  ).toBeTruthy()
  expect(screen.queryByText("Questions answered")).toBeNull()
  expect(request).toHaveBeenLastCalledWith("session/question/answer", {
    sessionId: "session_questions",
    toolCallId: "ask_1",
    answers: ["Custom directory"],
  })
  act(() =>
    useAppStore.setState({
      execution: {
        ...createExecutionViewState(),
        entries: [
          {
            kind: "user_input",
            inputId: "answer_1",
            questionId: "ask_1",
            text: "Custom directory",
            at: "2026-09-22T00:00:00Z",
            content: inputParts("Custom directory"),
          },
        ],
      },
    }),
  )
  expect(screen.getByText("Questions answered")).toBeTruthy()
  expect(
    screen.queryByRole("button", { name: "Retry same answers" }),
  ).toBeNull()
  expect(
    questionAnswerMemory.read(
      useAppStore.getState().apiBase,
      "session_questions",
      "ask_1",
    ),
  ).toBeUndefined()
})

it.each([
  "before failure",
  "after failure",
])("keeps unconfirmed answers retryable when the question closes %s", async (timing) => {
  let reject!: (error: Error) => void
  request
    .mockReturnValueOnce(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      }),
    )
    .mockResolvedValueOnce({})
  useAppStore.setState({
    selection: { sessionId: "session_closed_outbox" },
    execution: {
      ...createExecutionViewState(),
      pendingQuestionIds: ["ask_closing"],
    },
  })
  const user = userEvent.setup()
  render(
    <UserQuestionsCell
      toolCallId="ask_closing"
      itemId="item_ask_closing"
      request={{
        kind: "user_questions",
        questions: [
          { title: "Destination?", options: ["Workspace", "Downloads"] },
        ],
      }}
    />,
  )
  await user.type(
    screen.getByRole("combobox", { name: "Destination?" }),
    "Custom directory",
  )
  await user.click(screen.getByRole("button", { name: "Send answers" }))
  const closeQuestion = () =>
    act(() => useAppStore.setState({ execution: createExecutionViewState() }))
  if (timing === "before failure") {
    closeQuestion()
    expect(screen.getByRole("button", { name: "Sending…" })).toHaveProperty(
      "disabled",
      true,
    )
  }
  await act(async () => reject(new Error("Disconnected")))
  if (timing === "after failure") closeQuestion()

  expect(screen.getByText("Question closed")).toBeTruthy()
  expect(screen.getByText("Custom directory")).toBeTruthy()
  expect(screen.getByText("Workspace")).toBeTruthy()
  expect(screen.getByRole("status").textContent).toContain("unconfirmed")
  expect(screen.queryByRole("combobox")).toBeNull()
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(screen.queryByRole("button", { name: "Skip questions" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull()
  expect(request).toHaveBeenCalledOnce()

  await user.click(screen.getByRole("button", { name: "Retry same answers" }))
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]).toEqual(request.mock.calls[0])
  expect(request).toHaveBeenLastCalledWith("session/question/answer", {
    sessionId: "session_closed_outbox",
    toolCallId: "ask_closing",
    answers: ["Custom directory"],
  })
  expect(
    await screen.findByText("Answers received; waiting for confirmation."),
  ).toBeTruthy()
  expect(screen.getByText("Question closed")).toBeTruthy()
})

it("requests draft recovery when a closed question answer is definitively rejected", async () => {
  let reject!: (error: Error) => void
  request.mockReturnValue(
    new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise
    }),
  )
  const originalRestoreQuestionDraft =
    useAppStore.getState().restoreQuestionDraft
  const restoreQuestionDraft = vi.fn()
  useAppStore.setState({
    restoreQuestionDraft,
    selection: { sessionId: "session_rejected_closed" },
    execution: {
      ...createExecutionViewState(),
      pendingQuestionIds: ["ask_rejected_closed"],
    },
  })
  try {
    const user = userEvent.setup()
    render(
      <UserQuestionsCell
        toolCallId="ask_rejected_closed"
        itemId="item_ask_rejected_closed"
        request={{
          kind: "user_questions",
          questions: [{ title: "Destination?" }],
        }}
      />,
    )
    await user.type(
      screen.getByRole("textbox", { name: "Destination?" }),
      "Custom directory",
    )
    await user.click(screen.getByRole("button", { name: "Send answers" }))
    act(() => useAppStore.setState({ execution: createExecutionViewState() }))
    await act(async () =>
      reject(new ApiRequestError("Invalid answer", "invalid_input")),
    )

    expect(restoreQuestionDraft).toHaveBeenCalledExactlyOnceWith(
      "session_rejected_closed",
      "ask_rejected_closed",
    )
    expect(
      questionAnswerMemory.read(
        useAppStore.getState().apiBase,
        "session_rejected_closed",
        "ask_rejected_closed",
      ),
    ).toBeUndefined()
    expect(screen.getByText("Question closed")).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toBe("Invalid answer")
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
  } finally {
    useAppStore.setState({ restoreQuestionDraft: originalRestoreQuestionDraft })
  }
})

it("renders a restored answered question without offering another submission", () => {
  const current = useAppStore.getState()
  useAppStore.setState({
    execution: {
      ...current.execution,
      entries: [
        {
          kind: "user_input",
          inputId: "answer_1",
          questionId: "ask_1",
          text: "Workspace",
          at: "2026-09-22T00:00:00Z",
          content: inputParts("Workspace"),
        },
      ],
    },
  })
  render(
    <UserQuestionsCell
      toolCallId="ask_1"
      itemId="item_ask_1"
      request={{
        kind: "user_questions",
        questions: [{ title: "Destination?" }],
      }}
    />,
  )
  expect(screen.getByText("Questions answered")).toBeTruthy()
  expect(screen.queryByRole("textbox")).toBeNull()
})

it.each([
  {
    questions: [{ title: "Destination?", options: ["Workspace", "Downloads"] }],
    label: "Question closed",
  },
  {
    questions: [
      { title: "Destination?", options: ["Workspace", "Downloads"] },
      { title: "Format?", options: ["Markdown", "Plain text"] },
    ],
    label: "Questions closed",
  },
])("keeps closed question history read-only with $label", ({
  questions,
  label,
}) => {
  useAppStore.setState({
    execution: {
      ...createExecutionViewState(),
      pendingQuestionIds: ["ask_other"],
    },
  })
  render(
    <UserQuestionsCell
      toolCallId="ask_closed"
      itemId="item_ask_closed"
      request={{ kind: "user_questions", questions }}
    />,
  )
  expect(screen.getByText(label)).toBeTruthy()
  for (const question of questions) {
    expect(screen.getByText(question.title)).toBeTruthy()
    for (const option of question.options) {
      expect(screen.getByText(option)).toBeTruthy()
    }
  }
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(screen.queryByRole("combobox")).toBeNull()
  expect(screen.queryByRole("button")).toBeNull()
  expect(request).not.toHaveBeenCalled()
})

it("skips open questions through the store action", async () => {
  const originalDismissQuestions = useAppStore.getState().dismissQuestions
  const dismissQuestions = vi.fn(() => {
    useAppStore.setState({ execution: createExecutionViewState() })
  })
  useAppStore.setState({
    dismissQuestions,
    selection: { sessionId: "session_skip" },
    execution: {
      ...createExecutionViewState(),
      pendingQuestionIds: ["ask_skip"],
    },
  })
  const user = userEvent.setup()
  render(
    <UserQuestionsCell
      toolCallId="ask_skip"
      itemId="item_ask_skip"
      request={{
        kind: "user_questions",
        questions: [
          { title: "Destination?", options: ["Workspace", "Downloads"] },
        ],
      }}
    />,
  )
  await user.click(screen.getByRole("button", { name: "Skip questions" }))
  expect(dismissQuestions).toHaveBeenCalledExactlyOnceWith("ask_skip")
  expect(screen.getByText("Question closed")).toBeTruthy()
  expect(screen.getByText("Workspace")).toBeTruthy()
  expect(screen.queryByRole("button")).toBeNull()
  expect(request).not.toHaveBeenCalled()
  useAppStore.setState({ dismissQuestions: originalDismissQuestions })
})

it("keeps plan updates compact and exposes persisted step states by keyboard", async () => {
  const user = userEvent.setup()
  render(
    <PlanCell
      plan={{
        kind: "plan",
        explanation: "The source is ready for implementation.",
        plan: [
          { step: "Inspect source", status: "completed" },
          { step: "Implement", status: "in_progress" },
          { step: "Verify", status: "pending" },
        ],
      }}
    />,
  )
  const trigger = screen.getByRole("button", {
    name: "Updated plan · 1/3 completed",
  })
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByRole("listitem")).toBeNull()
  expect(
    screen.queryByText("The source is ready for implementation."),
  ).toBeNull()
  await user.tab()
  expect(document.activeElement).toBe(trigger)
  await user.keyboard("{Enter}")
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  expect(screen.getAllByRole("listitem")).toHaveLength(3)
  expect(screen.getByLabelText("in progress")).toBeTruthy()
  expect(screen.getByText("Verify")).toBeTruthy()
  expect(
    screen.getByText("The source is ready for implementation."),
  ).toBeTruthy()
  await user.keyboard(" ")
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByRole("listitem")).toBeNull()
})

it("restores an unconfirmed answer after remount without resending automatically", async () => {
  const user = userEvent.setup()
  useAppStore.setState({
    selection: { sessionId: "session_questions" },
    execution: {
      ...createExecutionViewState(),
      pendingQuestionIds: ["ask_2"],
    },
  })
  request.mockResolvedValue({})
  const props = {
    toolCallId: "ask_2",
    itemId: "item_ask_2",
    request: {
      kind: "user_questions" as const,
      questions: [{ title: "Where?" }],
    },
  }
  const view = render(<UserQuestionsCell {...props} />)
  await user.type(screen.getByRole("textbox", { name: "Where?" }), "Workspace")
  await user.click(screen.getByRole("button", { name: "Send answers" }))
  view.unmount()
  render(<UserQuestionsCell {...props} />)
  expect(screen.getByRole("textbox", { name: "Where?" })).toHaveProperty(
    "value",
    "Workspace",
  )
  expect(screen.getByRole("status").textContent).toContain("unconfirmed")
  expect(request).toHaveBeenCalledOnce()
  await user.click(screen.getByRole("button", { name: "Retry same answers" }))
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]).toEqual(request.mock.calls[0])
})

it("does not show a late transport error after the answer is durably confirmed", async () => {
  let reject!: (error: Error) => void
  request.mockReturnValue(
    new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise
    }),
  )
  const user = userEvent.setup()
  useAppStore.setState({
    selection: { sessionId: "session_questions" },
    execution: {
      ...createExecutionViewState(),
      pendingQuestionIds: ["ask_late"],
    },
  })
  render(
    <UserQuestionsCell
      toolCallId="ask_late"
      itemId="item_ask_late"
      request={{ kind: "user_questions", questions: [{ title: "Where?" }] }}
    />,
  )
  await user.type(screen.getByRole("textbox", { name: "Where?" }), "Workspace")
  await user.click(screen.getByRole("button", { name: "Send answers" }))
  act(() =>
    useAppStore.setState({
      execution: {
        ...createExecutionViewState(),
        entries: [
          {
            kind: "user_input",
            inputId: "answer_late",
            questionId: "ask_late",
            text: "Workspace",
            at: "2026-09-22T00:00:00Z",
            content: inputParts("Workspace"),
          },
        ],
      },
    }),
  )
  await act(async () => reject(new Error("Delivery unknown")))
  expect(screen.getByText("Questions answered")).toBeTruthy()
  expect(screen.queryByRole("alert")).toBeNull()
  expect(
    questionAnswerMemory.read(
      useAppStore.getState().apiBase,
      "session_questions",
      "ask_late",
    ),
  ).toBeUndefined()
})

it("allows editing answers after an explicit validation rejection", async () => {
  request.mockRejectedValue(
    new ApiRequestError("Invalid answer", "invalid_input"),
  )
  const user = userEvent.setup()
  useAppStore.setState({
    selection: { sessionId: "session_questions" },
    execution: {
      ...createExecutionViewState(),
      pendingQuestionIds: ["ask_invalid"],
    },
  })
  render(
    <UserQuestionsCell
      toolCallId="ask_invalid"
      itemId="item_ask_invalid"
      request={{ kind: "user_questions", questions: [{ title: "Where?" }] }}
    />,
  )
  const input = screen.getByRole("textbox", { name: "Where?" })
  await user.type(input, "Workspace")
  await user.click(screen.getByRole("button", { name: "Send answers" }))
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Invalid answer",
  )
  expect(input).toHaveProperty("disabled", false)
  expect(
    questionAnswerMemory.read(
      useAppStore.getState().apiBase,
      "session_questions",
      "ask_invalid",
    ),
  ).toBeUndefined()
})
