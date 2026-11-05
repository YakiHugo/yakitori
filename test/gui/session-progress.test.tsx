// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import {
  PlanCell,
  UserQuestionsCell,
} from "../../src/gui/components/cells/session-progress-cell.tsx"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import { inputParts } from "./input-fixtures.ts"

const request = vi.hoisted(() => vi.fn())
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))
afterEach(() => {
  cleanup()
  request.mockReset()
})

it("sends a correlated free-text answer and keeps failed submissions editable", async () => {
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
  await user.click(screen.getByRole("button", { name: "Send answers" }))
  expect(await screen.findByText("Questions answered")).toBeTruthy()
  expect(request).toHaveBeenLastCalledWith("session/question/answer", {
    sessionId: "session_questions",
    toolCallId: "ask_1",
    answers: ["Custom directory"],
  })
  expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull()
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
