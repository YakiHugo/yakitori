// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  PlanCell,
  UserQuestionsCell,
} from "../../src/gui/components/cells/session-progress-cell.tsx"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import { questionAnswerMemory } from "../../src/gui/question-answer-memory.ts"
import { createExecutionViewState } from "../../src/gui/execution-view.ts"
import { inputParts } from "./input-fixtures.ts"

const request = vi.hoisted(() => vi.fn())
vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => ({ request }),
}))
beforeEach(() => {
  questionAnswerMemory.clear()
  useAppStore.setState({ execution: createExecutionViewState() })
})
afterEach(() => {
  cleanup()
  request.mockReset()
})

it("retries the same correlated answer and waits for durable confirmation", async () => {
  useAppStore.setState({
    selection: {
      ...useAppStore.getState().selection,
      sessionId: "session_questions",
    },
  })
  request
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce({})
  const user = userEvent.setup()
  render(
    <UserQuestionsCell
      toolCallId="ask_1"
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
      request={{
        kind: "user_questions",
        questions: [{ title: "Destination?" }],
      }}
    />,
  )
  expect(screen.getByText("Questions answered")).toBeTruthy()
  expect(screen.queryByRole("textbox")).toBeNull()
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
  useAppStore.setState({ selection: { sessionId: "session_questions" } })
  request.mockResolvedValue({})
  const props = {
    toolCallId: "ask_2",
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
  useAppStore.setState({ selection: { sessionId: "session_questions" } })
  render(
    <UserQuestionsCell
      toolCallId="ask_late"
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
  useAppStore.setState({ selection: { sessionId: "session_questions" } })
  render(
    <UserQuestionsCell
      toolCallId="ask_invalid"
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
