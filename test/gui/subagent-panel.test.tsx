// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SubagentPanel } from "../../src/gui/components/subagent-panel.tsx"
import {
  type AppRpcClient,
  createAppRpcClient,
} from "../../src/gui/lib/rpc-client.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  createEventEnvelope,
  type KernelEvent,
  type TurnOutcome,
} from "../../src/kernel/events.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"
import { FakeRpcClient, type FakeSessionStream } from "./fake-rpc-client.ts"

vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  createAppRpcClient: vi.fn(),
}))

const at = "2026-09-20T00:00:00.000Z"
const snapshot: ApiSessionDetail = {
  id: "child",
  conversationId: "child",
  title: "Inspect renderer",
  seq: 0,
  createdAt: at,
  updatedAt: at,
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
}
const props = {
  sessionId: "child",
  apiBase: "http://localhost:3001",
  active: true,
  onBack: vi.fn(),
  onOpenAgent: vi.fn(),
}
let rpc: FakeRpcClient
let stream: FakeSessionStream
let seq: number

function emit(event: KernelEvent) {
  stream.emitEvent(
    createEventEnvelope({
      sessionId: "child",
      seq: ++seq,
      createdAt: at,
      event,
    }),
  )
}
function mount() {
  const result = render(<SubagentPanel {...props} />)
  const opened = rpc.streams[0]
  if (!opened) throw new Error("Panel did not subscribe")
  stream = opened
  return result
}
function start() {
  stream.emitSnapshot({ session: { ...snapshot, activeTurnId: "turn" } })
  emit({
    type: "input.admitted",
    data: {
      requestId: "request",
      inputId: "input",
      role: "user",
      content: { kind: "text", text: "Review the renderer" },
    },
  })
  emit({ type: "turn.started", data: { turnId: "turn", inputId: "input" } })
  stream.emitReplayComplete()
}

beforeEach(() => {
  rpc = new FakeRpcClient()
  seq = 0
  vi.mocked(createAppRpcClient).mockReturnValue(rpc as unknown as AppRpcClient)
  useAppStore.setState({
    ...createInitialAppState(),
    selection: { sessionId: "parent" },
    promptDraft: "Parent draft",
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("replays a child with readable markdown answers and disclosed activity without changing the parent", () => {
  const before = useAppStore.getState()
  mount()
  act(() => {
    start()
    emit({
      type: "item.completed",
      data: {
        turnId: "turn",
        item: {
          type: "reasoning",
          itemId: "reasoning",
          text: "Inspecting the layout",
        },
      },
    })
    emit({
      type: "item.completed",
      data: {
        turnId: "turn",
        item: {
          type: "agent_message",
          itemId: "answer",
          content: [{ type: "text", text: "**Renderer verified**" }],
        },
      },
    })
    emit({
      type: "turn.completed",
      data: { turnId: "turn", outcome: { status: "completed" } },
    })
  })
  expect(screen.getByText("Review the renderer")).toBeDefined()
  expect(screen.getByText("Renderer verified").tagName).toBe("STRONG")
  expect(screen.getByText("Completed")).toBeDefined()
  expect(screen.queryByText("Inspecting the layout")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /Activity/ }))
  fireEvent.click(screen.getByRole("button", { name: "Reasoning" }))
  expect(screen.getByText("Inspecting the layout")).toBeDefined()
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(useAppStore.getState().selection).toBe(before.selection)
  expect(useAppStore.getState().execution).toBe(before.execution)
  expect(useAppStore.getState().promptDraft).toBe("Parent draft")
  fireEvent.click(screen.getByRole("button", { name: "Back to agents" }))
  expect(props.onBack).toHaveBeenCalledOnce()
})

it("reconciles live output against an idle reconnect snapshot", () => {
  mount()
  act(() => {
    start()
    stream.emitTransient({
      type: "item.started",
      sessionId: "child",
      turnId: "turn",
      item: { type: "agent_message", itemId: "answer" },
      createdAt: at,
    })
    stream.emitTransient({
      type: "assistant.delta",
      sessionId: "child",
      turnId: "turn",
      itemId: "answer",
      delta: "Partial result",
      createdAt: at,
    })
  })
  expect(screen.getByText("Partial result")).toBeDefined()
  expect(screen.getByText("Working")).toBeDefined()
  act(() => {
    stream.emitSnapshot({ session: { ...snapshot, seq } })
    stream.emitReplayComplete()
  })
  expect(screen.getByText("Interrupted")).toBeDefined()
  expect(screen.getByText(/Turn interrupted/)).toBeDefined()
  expect(screen.getByText("Partial result")).toBeDefined()
})

it("answers child permissions on its own connection and reports an unavailable answer channel", () => {
  mount()
  act(() => {
    start()
    stream.emitTransient({
      type: "permission.requested",
      sessionId: "child",
      turnId: "turn",
      toolCallId: "tool",
      permissionRequestId: "permission",
      action: "exec_command",
      createdAt: at,
    })
  })
  expect(screen.getByText("Awaiting approval")).toBeDefined()
  rpc.answerError = new Error("Permission channel unavailable")
  fireEvent.click(screen.getByRole("button", { name: "Allow" }))
  expect(screen.getByRole("alert").textContent).toBe(
    "Permission channel unavailable",
  )
  rpc.answerError = undefined
  fireEvent.click(screen.getByRole("button", { name: "Deny" }))
  expect(rpc.answeredPermissions).toEqual([
    {
      permissionRequestId: "permission",
      result: { behavior: "deny", reason: { kind: "user_denied" } },
    },
  ])
  expect(
    (screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
})

it("closes its own connection on child changes and ignores late deliveries", () => {
  const close = vi.spyOn(rpc, "close")
  const { rerender, unmount } = mount()
  act(start)
  const oldStream = stream
  rerender(<SubagentPanel {...props} sessionId="another-child" />)
  expect(oldStream.closed).toBe(true)
  expect(close).toHaveBeenCalledOnce()
  act(() =>
    oldStream.emitTransient({
      type: "assistant.delta",
      sessionId: "child",
      turnId: "turn",
      itemId: "late",
      delta: "Stale output",
      createdAt: at,
    }),
  )
  expect(screen.queryByText("Stale output")).toBeNull()
  expect(screen.queryByText("Review the renderer")).toBeNull()
  unmount()
  expect(close).toHaveBeenCalledTimes(2)
})

it("keeps live scrolling pinned until the reader scrolls away", () => {
  const { container } = mount()
  const viewport = container.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  )
  if (!viewport) throw new Error("Missing viewport")
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 300, configurable: true },
  })
  act(start)
  expect(viewport.scrollTop).toBe(1000)
  fireEvent.wheel(viewport, { deltaY: -100 })
  viewport.scrollTop = 200
  fireEvent.scroll(viewport)
  act(() =>
    stream.emitTransient({
      type: "assistant.delta",
      sessionId: "child",
      turnId: "turn",
      itemId: "answer",
      delta: "New output",
      createdAt: at,
    }),
  )
  expect(viewport.scrollTop).toBe(200)
  expect(
    screen.getByRole("button", { name: "Jump to latest child output" }),
  ).toBeDefined()
})

it.each<{ outcome: TurnOutcome; label: string; message: string }>([
  {
    outcome: { status: "failed", error: { message: "Provider unavailable" } },
    label: "Failed",
    message: "Provider unavailable",
  },
  {
    outcome: { status: "cancelled", reason: "Stopped by parent" },
    label: "Cancelled",
    message: "Stopped by parent",
  },
])("shows $label outside collapsed activity", ({ outcome, label, message }) => {
  mount()
  act(() => {
    start()
    emit({ type: "turn.completed", data: { turnId: "turn", outcome } })
  })
  expect(screen.getByText(label)).toBeDefined()
  expect(screen.getByText(new RegExp(message))).toBeDefined()
})

it("retries a terminal subscription failure from the last durable cursor", () => {
  mount()
  act(start)
  act(() => stream.failSubscription(new Error("Child session unavailable")))
  expect(screen.getByRole("alert").textContent).toContain(
    "Child session unavailable",
  )
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(stream.closed).toBe(true)
  const retry = rpc.streams[1]
  expect(retry?.after).toBe(2)
  act(() => {
    retry?.emitSnapshot({ session: { ...snapshot, seq: 2 } })
    retry?.emitReplayComplete()
  })
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.getByText("Review the renderer")).toBeDefined()
})
