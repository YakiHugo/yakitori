// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
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

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
function frame(now: number) {
  act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(now)
  })
}
function scrollGeometry(viewport: HTMLElement) {
  let top = 0
  Object.defineProperties(viewport, {
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(
          0,
          Math.min(viewport.scrollHeight - viewport.clientHeight, value),
        )
      },
      configurable: true,
    },
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 400, configurable: true },
  })
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.spyOn(performance, "now").mockReturnValue(0)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
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
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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
  fireEvent.click(screen.getByRole("button", { name: "Worked for 1m 49s" }))
  expect(
    screen
      .getByText("Checking the implementation", { selector: "p" })
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("true")
  expect(
    screen.getByText(/Provider disconnected/).closest("[aria-hidden]"),
  ).toBeNull()
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
  const first = screen.getByRole("button", {
    name: "Jump to message 1: First request",
  })
  expect(first).toBeDefined()
  expect(
    screen.getByRole("button", { name: "Jump to message 2: Follow-up" }),
  ).toBeDefined()

  const viewport = document.querySelector(
    "[data-slot=scroll-area-viewport]",
  ) as HTMLElement
  scrollGeometry(viewport)
  viewport.scrollTop = viewport.scrollHeight
  const rect = (top: number, bottom: number) =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  let anchor: HTMLElement = screen.getByText("First request", {
    selector: "p",
  })
  while (!anchor.parentElement?.className.includes("conversation-content")) {
    anchor = anchor.parentElement as HTMLElement
  }
  viewport.getBoundingClientRect = () => rect(0, 400)
  anchor.getBoundingClientRect = () => rect(-100, -60)

  fireEvent.click(first)
  frame(300)
  expect(viewport.scrollTop).toBe(676)
  expect(
    screen
      .getByRole("button", { name: "Jump to latest output" })
      .getAttribute("data-visible"),
  ).toBe("true")
})

it("marks only the rail markers whose turns intersect the viewport", () => {
  useAppStore.setState({
    execution: {
      ...createExecutionViewState(),
      entries: [
        { kind: "user_input", inputId: "input_1", text: "First request", at },
        {
          kind: "assistant",
          itemId: "answer_1",
          turnId: "turn_1",
          text: "Answer one",
          status: "completed",
          at,
        },
        {
          kind: "user_input",
          inputId: "input_2",
          text: "Second request",
          at,
        },
        {
          kind: "assistant",
          itemId: "answer_2",
          turnId: "turn_2",
          text: "Answer two",
          status: "completed",
          at,
        },
      ],
    },
  })
  render(<Transcript />)
  const viewport = document.querySelector(
    "[data-slot=scroll-area-viewport]",
  ) as HTMLElement
  const rect = (top: number, bottom: number) =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  const anchorFor = (text: string) => {
    let node: HTMLElement = screen.getByText(text, { selector: "p" })
    while (!node.parentElement?.className.includes("conversation-content")) {
      node = node.parentElement as HTMLElement
    }
    return node
  }
  const first = screen.getByRole("button", {
    name: "Jump to message 1: First request",
  })
  const second = screen.getByRole("button", {
    name: "Jump to message 2: Second request",
  })

  viewport.getBoundingClientRect = () => rect(100, 500)
  anchorFor("First request").getBoundingClientRect = () => rect(-300, -250)
  anchorFor("Second request").getBoundingClientRect = () => rect(50, 90)
  fireEvent.scroll(viewport)
  expect(first.getAttribute("aria-current")).toBeNull()
  expect(second.getAttribute("aria-current")).toBe("location")

  // A tall first turn stays marked while its content fills the viewport, even
  // though its own bubble has scrolled out.
  anchorFor("Second request").getBoundingClientRect = () => rect(600, 650)
  fireEvent.scroll(viewport)
  expect(first.getAttribute("aria-current")).toBe("location")
  expect(second.getAttribute("aria-current")).toBeNull()
})

it("does not display replayed activity until the selected session finishes restoring", () => {
  useAppStore.setState({ hydratingSessionId: "session_1" })
  render(<App />)
  expect(within(screen.getByRole("main")).getByRole("status").textContent).toBe(
    "Loading conversation…",
  )
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
  expect(
    screen
      .getByText("Checking the implementation", { selector: "p" })
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("true")
  expect(
    screen.getByText("Permission · Write config").closest("[aria-hidden]"),
  ).toBeNull()
  expect(
    screen.getByText("awaiting approval").closest("[aria-hidden]"),
  ).toBeNull()
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

it("reveals a jump-to-latest button when the reader scrolls up and returns to the bottom on click", () => {
  render(<Transcript />)
  const viewport = document.querySelector(
    "[data-slot=scroll-area-viewport]",
  ) as HTMLElement
  scrollGeometry(viewport)
  // aria-hidden elements compute an empty accessible name, so the collapsed
  // button is located by its aria-label attribute instead of its role.
  const button = document.querySelector(
    "button[aria-label='Jump to latest output']",
  ) as HTMLElement
  expect(button.getAttribute("data-visible")).toBe("false")
  expect(button.tabIndex).toBe(-1)

  viewport.scrollTop = 0
  fireEvent.scroll(viewport)
  expect(button.getAttribute("data-visible")).toBe("true")
  expect(button.getAttribute("aria-hidden")).toBe("false")
  expect(button.tabIndex).toBe(0)

  fireEvent.click(button)
  frame(300)
  expect(viewport.scrollTop).toBe(800)
  expect(button.getAttribute("data-visible")).toBe("false")
  expect(button.tabIndex).toBe(-1)
})

it("marks a queued input as pending until it is admitted", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries.slice(0, 2),
        { kind: "user_input", inputId: "input_2", text: "Follow-up", at },
        ...entries.slice(2),
      ],
      queuedInputs: {
        input_2: { id: "input_2", text: "Follow-up", admittedAt: at },
      },
    },
  })
  render(<Transcript />)
  const blockFor = (text: string) => {
    let node: HTMLElement = screen.getByText(text, { selector: "p" })
    while (!node.parentElement?.className.includes("conversation-content")) {
      node = node.parentElement as HTMLElement
    }
    return node
  }
  expect(within(blockFor("Follow-up")).getByText("queued")).toBeDefined()
  expect(within(blockFor("First request")).queryByText("queued")).toBeNull()

  act(() =>
    useAppStore.setState({
      execution: { ...useAppStore.getState().execution, queuedInputs: {} },
    }),
  )
  expect(screen.queryByText("queued")).toBeNull()
  expect(screen.getByText("Follow-up", { selector: "p" })).toBeDefined()
})
