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
import { TooltipProvider } from "../../src/gui/components/ui/tooltip.tsx"
import {
  createExecutionViewState,
  type ExecutionEntry,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { fileReadExecution } from "../../src/runtime/tools/execution-descriptors.ts"

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

function readTool(
  toolCallId: string,
  path: string,
  state = "completed",
): ExecutionEntry {
  return {
    kind: "tool",
    toolCallId,
    turnId: "turn_1",
    execution: {
      ...fileReadExecution({ path }),
      itemId: `item_${toolCallId}`,
      toolCallId,
      name: "read_file",
      input: { path },
      requiresPermission: false,
    },
    state,
    resultText: `${path} contents`,
    ...(state === "failed"
      ? { resultError: true, resultErrorMessage: "Could not read file" }
      : {}),
  }
}

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

function centeredConversationGeometry() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        this.classList.contains("conversation-content") ? 48 : 0,
        0,
        this.classList.contains("conversation-content") ? 768 : 864,
        400,
      )
    },
  )
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

it("keeps intent updates visible and consolidates reasoning behind the turn summary", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries.slice(0, 3),
        readTool("tool_between_reasoning", "src/index.ts"),
        {
          kind: "reasoning",
          itemId: "reasoning_2",
          turnId: "turn_1",
          text: "More reasoning details",
          status: "completed",
          at,
        },
        ...entries.slice(3),
      ],
    },
  })
  render(<Transcript />)
  expect(screen.getByText("Final answer")).toBeDefined()
  expect(
    screen
      .getByText("Checking the implementation", { selector: "p" })
      .closest("[aria-hidden]"),
  ).toBeNull()
  expect(screen.queryByText("Reasoning details", { selector: "p" })).toBeNull()
  const toggles = screen.getAllByRole("button", { name: "Worked for 1m 49s" })
  expect(toggles).toHaveLength(1)
  const [toggle] = toggles
  if (toggle === undefined) throw new Error("Expected a reasoning disclosure")
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  const disclosure = document.getElementById(
    toggle.getAttribute("aria-controls") ?? "",
  )
  expect(disclosure?.getAttribute("aria-hidden")).toBe("true")
  fireEvent.click(toggle)
  expect(
    screen
      .getByText("Reasoning details", { selector: "p" })
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("false")
  expect(
    screen
      .getByText("More reasoning details", { selector: "p" })
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden"),
  ).toBe("false")
  fireEvent.click(toggle)
  expect(screen.queryByText("Reasoning details", { selector: "p" })).toBeNull()
  expect(disclosure?.getAttribute("aria-hidden")).toBe("true")
  expect(screen.getByText("Final answer")).toBeDefined()
})

it("groups adjacent tool actions behind a deterministic collapsed summary", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries.slice(0, 2),
        readTool("tool_1", "src/first.ts"),
        readTool("tool_2", "src/second.ts"),
        ...entries.slice(2),
      ],
    },
  })
  render(<Transcript />)

  expect(
    screen
      .getByText("Checking the implementation", { selector: "p" })
      .closest("[aria-hidden]"),
  ).toBeNull()
  const tools = screen.getByRole("button", {
    name: "Used tools · Read 2",
  })
  expect(tools.getAttribute("aria-expanded")).toBe("false")
  expect(
    screen.queryByRole("button", { name: /Read src\/first\.ts/ }),
  ).toBeNull()

  fireEvent.click(tools)

  expect(
    screen.getByRole("button", { name: /Read src\/first\.ts/ }),
  ).toBeDefined()
  expect(
    screen.getByRole("button", { name: /Read src\/second\.ts/ }),
  ).toBeDefined()
})

it("surfaces a failed action instead of hiding it in a closed tool group", () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries.slice(0, 2),
        readTool("tool_failed", "src/missing.ts", "failed"),
        ...entries.slice(2),
      ],
    },
  })
  render(<Transcript />)

  expect(
    screen
      .getByRole("button", { name: "Tool failed · Read" })
      .getAttribute("aria-expanded"),
  ).toBe("true")
  expect(
    screen.getByRole("button", { name: /Read src\/missing\.ts/ }),
  ).toBeDefined()
  expect(screen.getByText("Could not read file")).toBeDefined()
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
  expect(screen.getByText("Final answer").closest("[aria-hidden]")).toBeNull()
})

it("shows retry activity before any output and restores the activity heading on recovery", () => {
  useAppStore.setState({
    execution: {
      ...createExecutionViewState(),
      entries: entries.slice(0, 1),
      activeTurnId: "turn_1",
    },
  })
  render(
    <TooltipProvider>
      <Transcript />
    </TooltipProvider>,
  )
  expect(screen.getByRole("status").textContent).toBe("Working")
  act(() => {
    useAppStore.setState((state) => ({
      execution: reduceExecutionView(state.execution, {
        type: "transient",
        event: {
          type: "runtime.warning",
          sessionId: "session_1",
          turnId: "turn_1",
          code: "model.retry",
          message:
            "Model request failed (connection_failed); retrying in 336 ms.",
          details: {
            kind: "connection_failed",
            nextAttempt: 2,
            maxAttempts: 4,
            delayMs: 336,
          },
          createdAt: at,
        },
      }),
    }))
  })
  const status = screen.getByRole("status")
  expect(status.textContent).toBe("Reconnecting · attempt 2/4")
  expect(status.closest("section")?.getAttribute("aria-label")).toBe(
    "Current response",
  )
  expect(screen.getByRole("button", { name: "Retry details" })).toBeDefined()
  expect(screen.queryByText(/336 ms/)).toBeNull()
  expect(screen.queryByRole("alert")).toBeNull()

  act(() => {
    useAppStore.setState((state) => ({
      execution: reduceExecutionView(
        reduceExecutionView(state.execution, {
          type: "transient",
          event: {
            type: "item.started",
            sessionId: "session_1",
            turnId: "turn_1",
            item: { type: "agent_message", itemId: "answer" },
            createdAt: at,
          },
        }),
        {
          type: "transient",
          event: {
            type: "assistant.delta",
            sessionId: "session_1",
            turnId: "turn_1",
            itemId: "answer",
            delta: "Connection recovered",
            createdAt: at,
          },
        },
      ),
    }))
  })
  expect(screen.getByRole("status").textContent).toBe("Working")
  expect(screen.queryByText(/Reconnecting/)).toBeNull()
  expect(screen.queryByRole("button", { name: "Retry details" })).toBeNull()
  expect(screen.getByText("Connection recovered")).toBeDefined()
})

it("shows the current retry once when steering input splits the turn", () => {
  useAppStore.setState({
    execution: {
      ...createExecutionViewState(),
      activeTurnId: "turn_1",
      activeRetry: {
        turnId: "turn_1",
        kind: "rate_limited",
        nextAttempt: 3,
        maxAttempts: 4,
        delayMs: 1000,
        message: "Rate limit reached; retrying.",
      },
      entries: [
        ...entries.slice(0, 2),
        { kind: "user_input", inputId: "input_2", text: "Follow-up", at },
        ...entries.slice(2),
      ],
    },
  })
  render(
    <TooltipProvider>
      <Transcript />
    </TooltipProvider>,
  )
  expect(
    screen.getAllByText("Waiting for rate limit · attempt 3/4"),
  ).toHaveLength(1)
  expect(screen.getAllByRole("button", { name: "Retry details" })).toHaveLength(
    1,
  )
})

it("keeps failures and intent updates visible while reasoning is collapsed", () => {
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
      .closest("[aria-hidden]"),
  ).toBeNull()
  expect(
    screen.getByText(/Provider disconnected/).closest("[aria-hidden]"),
  ).toBeNull()
})

it("shows navigation only while the centered body leaves 48 layout pixels of margin", () => {
  let margin = 48
  // A transformed surface must use layout pixels, not its scaled screen gap.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        100 +
          (this.classList.contains("conversation-content") ? margin * 2 : 0),
        0,
        1728,
        800,
      )
    },
  )
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(864)
  const observers: { callback: () => void; targets: Element[] }[] = []
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets: Element[] = []
      constructor(callback: () => void) {
        observers.push({ callback, targets: this.targets })
      }
      observe(target: Element) {
        this.targets.push(target)
      }
      unobserve() {}
      disconnect() {}
    },
  )
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      entries: [
        ...entries,
        { kind: "user_input", inputId: "input_2", text: "Follow-up", at },
      ],
    },
  })
  render(<Transcript />)
  expect(
    screen.getByRole("navigation", { name: "Conversation messages" }),
  ).toBeDefined()
  const viewport = document.querySelector(".conversation-transcript-viewport")
  const content = document.querySelector(".conversation-content")
  const observer = observers.find(
    ({ targets }) =>
      targets.includes(viewport as Element) &&
      targets.includes(content as Element),
  )
  expect(observer).toBeDefined()
  for (const [nextMargin, visible] of [
    [47, false],
    [0, false],
    [48, true],
    [100, true],
  ] as const) {
    act(() => {
      margin = nextMargin
      observer?.callback()
    })
    expect(
      screen.queryByRole("navigation", { name: "Conversation messages" }) !==
        null,
    ).toBe(visible)
  }
})

it("offers an anchor for every input including inputs received during a turn", () => {
  centeredConversationGeometry()
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
  centeredConversationGeometry()
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

it("keeps pending approvals visible alongside intent updates", () => {
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
      .closest("[aria-hidden]"),
  ).toBeNull()
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
      .closest("[aria-hidden]"),
  ).toBeNull()
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
      screen.getByText(text, { selector: "p" }).closest("[aria-hidden]"),
    ).toBeNull()
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
      .closest("[aria-hidden]"),
  ).toBeNull()
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
