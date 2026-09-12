// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it } from "vitest"
import { App } from "../../src/gui/app.tsx"
import { Transcript } from "../../src/gui/components/transcript.tsx"
import {
  createExecutionViewState,
  type ExecutionEntry,
} from "../../src/gui/execution-view.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

const at = "2026-09-12T00:00:00Z"
const entries: ExecutionEntry[] = [
  { kind: "user_input", inputId: "input_1", text: "First request", at },
  {
    kind: "assistant",
    itemId: "progress",
    turnId: "turn_1",
    text: "Checking the implementation",
    status: "completed",
    at,
  },
  {
    kind: "reasoning",
    itemId: "reasoning",
    turnId: "turn_1",
    text: "Reasoning details",
    status: "completed",
    at,
  },
  {
    kind: "assistant",
    itemId: "answer",
    turnId: "turn_1",
    text: "Final answer",
    status: "completed",
    at,
  },
]

beforeEach(() => {
  useAppStore.setState({
    ...createInitialAppState(),
    selection: { sessionId: "session_1" },
    execution: {
      ...createExecutionViewState(),
      entries,
      turnTimings: {
        turn_1: { startedAt: at, completedAt: "2026-09-12T00:01:49Z" },
      },
    },
  })
})
afterEach(cleanup)

it("shows the final answer and lets the reader expand and collapse earlier activity", () => {
  render(<Transcript />)
  expect(screen.getByText("Final answer")).toBeDefined()
  expect(
    screen
      .getByText("Checking the implementation", { selector: "p" })
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("true")
  const toggle = screen.getByRole("button", { name: "Worked for 1m 49s" })
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  fireEvent.click(toggle)
  expect(
    screen.getByText("Checking the implementation", { selector: "p" }),
  ).toBeDefined()
  fireEvent.click(toggle)
  expect(
    screen
      .getByText("Checking the implementation", { selector: "p" })
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("true")
  expect(screen.getByText("Final answer")).toBeDefined()
})

it("keeps live process history available until the turn has a final answer", () => {
  useAppStore.setState({
    execution: { ...useAppStore.getState().execution, activeTurnId: "turn_1" },
  })
  render(<Transcript />)
  expect(screen.getByRole("button", { name: "Working" })).toBeDefined()
  expect(screen.getByText("Final answer")).toBeDefined()
  act(() =>
    useAppStore.setState({
      execution: {
        ...useAppStore.getState().execution,
        entries: [
          ...entries,
          {
            kind: "assistant",
            itemId: "next",
            turnId: "turn_1",
            text: "Latest output",
            status: "streaming",
            at,
          },
        ],
      },
    }),
  )
  expect(screen.getByText("Latest output")).toBeDefined()
  expect(
    screen
      .getByText("Final answer")
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("false")
})

it("keeps failures visible even when the preceding activity is collapsed", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries,
        {
          kind: "turn_terminal",
          turnId: "turn_1",
          state: "failed",
          message: "Provider disconnected",
        },
      ],
    },
  })
  render(<Transcript />)
  expect(screen.getByText(/Provider disconnected/)).toBeDefined()
})

it("offers an anchor for every input including inputs received during a turn", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries.slice(0, 2),
        { kind: "user_input", inputId: "input_2", text: "Follow-up", at },
        ...entries.slice(2),
      ],
    },
  })
  render(<Transcript />)
  expect(
    screen.getByRole("button", { name: "Jump to message 1: First request" }),
  ).toBeDefined()
  expect(
    screen.getByRole("button", { name: "Jump to message 2: Follow-up" }),
  ).toBeDefined()
})

it("does not display replayed activity until the selected session finishes restoring", () => {
  useAppStore.setState({ hydratingSessionId: "session_1" })
  render(<App />)
  expect(screen.getByRole("status").textContent).toBe("Loading conversation…")
  expect(screen.queryByText("First request")).toBeNull()
  expect(screen.queryByRole("textbox", { name: "Message the Mate" })).toBeNull()
})

it("keeps pending approvals outside the collapsed activity", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries,
        {
          kind: "permission",
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "tool_1",
          action: "Write config",
          state: "requested",
        },
      ],
    },
  })
  render(<Transcript />)
  expect(screen.getByText("Permission · Write config")).toBeDefined()
  expect(screen.getByText("awaiting approval")).toBeDefined()
})

it("promotes only the final answer of a completed turn split by another input", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries.slice(0, 2),
        { kind: "user_input", inputId: "input_2", text: "Follow-up", at },
        ...entries.slice(2),
      ],
    },
  })
  render(<Transcript />)
  expect(screen.getAllByRole("button", { name: "Copy response" })).toHaveLength(
    1,
  )
  expect(
    screen
      .getByText("Checking the implementation", { selector: "p" })
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("true")
  expect(
    screen
      .getByText("Final answer", { selector: "p" })
      .closest("[aria-hidden]"),
  ).toBeNull()
})

it("keeps every fragment of a failed turn as activity", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries.slice(0, 2),
        { kind: "user_input", inputId: "input_2", text: "Follow-up", at },
        ...entries.slice(2),
        {
          kind: "turn_terminal",
          turnId: "turn_1",
          state: "failed",
          message: "Provider disconnected",
        },
      ],
    },
  })
  render(<Transcript />)
  expect(screen.queryByRole("button", { name: "Copy response" })).toBeNull()
  for (const text of ["Checking the implementation", "Final answer"])
    expect(
      screen
        .getByText(text, { selector: "p" })
        .closest("[aria-hidden]")
        ?.getAttribute("aria-hidden"),
    ).toBe("false")
  expect(screen.getByText(/Provider disconnected/)).toBeDefined()
})

it("does not promote inactive text until its turn has completed", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      turnTimings: { turn_1: { startedAt: at } },
    },
  })
  render(<Transcript />)
  expect(screen.queryByRole("button", { name: "Copy response" })).toBeNull()
  expect(
    screen
      .getByText("Final answer", { selector: "p" })
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("false")
})
