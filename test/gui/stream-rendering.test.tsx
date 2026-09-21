// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import Markdown from "react-markdown"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"
import { Transcript } from "../../src/gui/components/transcript.tsx"
import {
  createExecutionViewState,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>()
  return { ...actual, default: vi.fn(actual.default) }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it("streams new text without parsing unchanged history or reasoning again", () => {
  const at = "2026-09-20T00:00:00Z"
  useAppStore.setState({
    selection: { sessionId: "session_1" },
    execution: {
      ...createExecutionViewState(),
      activeTurnId: "active",
      entries: [
        {
          kind: "assistant",
          itemId: "answer",
          turnId: "completed",
          text: "Completed **answer**",
          status: "completed",
          at,
        },
        {
          kind: "reasoning",
          itemId: "reasoning",
          turnId: "active",
          text: "Stable reasoning",
          status: "completed",
          at,
        },
        {
          kind: "assistant",
          itemId: "stream",
          turnId: "active",
          text: "Hello",
          status: "streaming",
          at,
        },
      ],
      itemEntryIndexes: { answer: 0, reasoning: 1, stream: 2 },
      turnTimings: { completed: { startedAt: at, completedAt: at } },
    },
  })
  render(<Transcript />)
  vi.mocked(Markdown).mockClear()

  act(() => {
    useAppStore.setState((state) => ({
      execution: reduceExecutionView(state.execution, {
        type: "transient",
        event: {
          type: "assistant.delta",
          sessionId: "session_1",
          turnId: "active",
          itemId: "stream",
          delta: " world",
          createdAt: at,
        },
      }),
    }))
  })
  expect(screen.getByText("Hello world")).toBeDefined()
  // Parsing unchanged Markdown is the expensive boundary this protects.
  expect(
    vi.mocked(Markdown).mock.calls.map(([props]) => props.children),
  ).toEqual(["Hello world"])

  fireEvent.click(screen.getByRole("button", { name: "Working" }))
  expect(
    screen
      .getByText("Stable reasoning")
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("false")
})

it("updates memoized Markdown when text, styling, or workspace changes", () => {
  const { rerender, container } = render(
    <MarkdownView text="First **answer**" workspaceRoot="/first" />,
  )
  vi.mocked(Markdown).mockClear()
  rerender(<MarkdownView text="First **answer**" workspaceRoot="/first" />)
  expect(Markdown).not.toHaveBeenCalled()

  rerender(
    <MarkdownView
      text="Second **answer**"
      workspaceRoot="/second"
      className="updated"
    />,
  )
  expect(screen.getByText("Second", { exact: false }).textContent).toBe(
    "Second answer",
  )
  expect(container.firstElementChild?.className).toBe("updated")
  expect(Markdown).toHaveBeenCalledTimes(1)
})

it("defers parsing hidden reasoning and expands the latest streamed text", () => {
  const at = "2026-09-20T00:00:00Z"
  useAppStore.setState({
    selection: { sessionId: "session_1" },
    execution: {
      ...createExecutionViewState(),
      activeTurnId: "active",
      entries: [
        {
          kind: "reasoning",
          itemId: "reasoning",
          turnId: "active",
          text: "Checking",
          status: "streaming",
          at,
        },
      ],
      itemEntryIndexes: { reasoning: 0 },
    },
  })
  render(<Transcript />)
  const toggle = screen.getByRole("button", { name: "Working" })
  const disclosure = document.getElementById(
    toggle.getAttribute("aria-controls") ?? "",
  )
  expect(disclosure?.getAttribute("aria-hidden")).toBe("true")
  expect(Markdown).not.toHaveBeenCalled()

  const appendReasoning = (delta: string) =>
    act(() => {
      useAppStore.setState((state) => ({
        execution: reduceExecutionView(state.execution, {
          type: "transient",
          event: {
            type: "reasoning.delta",
            sessionId: "session_1",
            turnId: "active",
            itemId: "reasoning",
            delta,
            createdAt: at,
          },
        }),
      }))
    })

  appendReasoning(" the **latest**")
  appendReasoning(" result")
  expect(Markdown).not.toHaveBeenCalled()
  expect(disclosure?.textContent).toBe("")

  fireEvent.click(toggle)
  expect(disclosure?.getAttribute("aria-hidden")).toBe("false")
  expect(disclosure?.textContent).toBe("Checking the latest result")
  expect(disclosure?.querySelector("strong")?.textContent).toBe("latest")
  appendReasoning(" now")
  expect(disclosure?.textContent).toBe("Checking the latest result now")

  fireEvent.click(toggle)
  vi.mocked(Markdown).mockClear()
  appendReasoning(" again")
  expect(disclosure?.getAttribute("aria-hidden")).toBe("true")
  expect(disclosure?.textContent).toBe("")
  expect(Markdown).not.toHaveBeenCalled()
  fireEvent.click(toggle)
  expect(disclosure?.textContent).toBe("Checking the latest result now again")
})
