// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ThreadGoal } from "../../src/core/goal.ts"
import { UserMessageCell } from "../../src/gui/components/cells/user-message-cell.tsx"
import { GoalBar, GoalEditor } from "../../src/gui/components/session-goal.tsx"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import type {
  ApiSessionDetail,
  ApiSetGoalRequest,
} from "../../src/server/protocol.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))
vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => fakeRef.current,
}))

const goal: ThreadGoal = {
  id: "goal_1",
  threadId: "session_1",
  objective: "Ship the feature",
  status: "active",
  tokensUsed: 500,
  timeUsedSeconds: 8,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}
const session: ApiSessionDetail = {
  id: "session_1",
  conversationId: "conversation_1",
  seq: 1,
  createdAt: goal.createdAt,
  updatedAt: goal.updatedAt,
  goal,
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

beforeEach(() => {
  fakeRef.current = new FakeRpcClient()
  useAppStore.setState({
    selection: { sessionId: session.id },
    selectedSession: session,
  })
  fakeRef.current.respond = (method, params) => {
    if (method === "goal/clear") return { goal: null }
    if (method !== "goal/set") throw new Error(`Unexpected request: ${method}`)
    const input = params as ApiSetGoalRequest
    const previous = useAppStore.getState().selectedSession?.goal ?? goal
    const { tokenBudget: _tokenBudget, ...base } = previous
    return {
      goal: {
        ...base,
        objective: input.objective ?? previous.objective,
        status: input.status ?? previous.status,
        ...(typeof input.inputId === "string"
          ? { inputId: input.inputId }
          : {}),
        ...(input.tokenBudget === null
          ? {}
          : { tokenBudget: input.tokenBudget ?? previous.tokenBudget }),
      },
    }
  }
})
afterEach(cleanup)

describe("session goal", () => {
  it("sets a message as the goal and marks its originating input", async () => {
    const user = userEvent.setup()
    render(
      <UserMessageCell
        entry={{
          kind: "user_input",
          inputId: "input_1",
          text: goal.objective,
          at: goal.createdAt,
        }}
        queued={false}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Set as goal" }))
    expect(fakeRef.current.requestsFor("goal/set")[0]?.params).toEqual({
      sessionId: session.id,
      objective: goal.objective,
      status: "active",
      inputId: "input_1",
    })
    expect(screen.getByText("Sent as goal")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Set as goal" })).toBeNull()
  })

  it("pauses, resumes, and clears using server goal operations", async () => {
    const user = userEvent.setup()
    render(<GoalBar />)
    // The server's execution time remains authoritative even with an old timestamp.
    expect(screen.getByText("· 8s")).toBeDefined()
    await user.click(screen.getByRole("button", { name: "Pause goal" }))
    expect(screen.getByText("Paused goal")).toBeDefined()
    await user.click(screen.getByRole("button", { name: "Resume goal" }))
    expect(screen.getByText("Pursuing goal")).toBeDefined()
    expect(
      fakeRef.current.requestsFor("goal/set").map((request) => request.params),
    ).toEqual([
      { sessionId: session.id, status: "paused" },
      { sessionId: session.id, status: "active" },
    ])
    await user.click(screen.getByRole("button", { name: "Clear goal" }))
    expect(screen.queryByText(goal.objective)).toBeNull()
    expect(fakeRef.current.requestsFor("goal/clear")[0]?.params).toEqual({
      sessionId: session.id,
    })
  })

  it.each([
    "blocked",
    "usage_limited",
    "complete",
    "budget_limited",
  ] as const)("shows the allowed control for %s", (status) => {
    useAppStore.setState({
      selectedSession: {
        ...session,
        goal: { ...goal, status, tokenBudget: 1000 },
      },
    })
    render(<GoalBar />)
    expect(screen.getByText("· 500 / 1,000 tokens")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Resume goal" }) !== null).toBe(
      status === "blocked" || status === "usage_limited",
    )
  })

  it("sets an explicit token budget and removes it when the editor is blank", async () => {
    const user = userEvent.setup()
    render(<GoalEditor />)
    act(() => useAppStore.getState().openGoalDialog())
    const input = screen.getByRole("spinbutton", {
      name: "Token budget (optional)",
    })
    await user.type(input, "1000")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(fakeRef.current.requestsFor("goal/set")[0]?.params).toEqual({
      sessionId: session.id,
      objective: goal.objective,
      tokenBudget: 1000,
    })
    await user.clear(input)
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(fakeRef.current.requestsFor("goal/set")[1]?.params).toEqual({
      sessionId: session.id,
      objective: goal.objective,
      tokenBudget: null,
    })
  })

  it("preserves unsaved edits when live accounting arrives and omits an unchanged budget", async () => {
    const user = userEvent.setup()
    render(<GoalEditor />)
    act(() => useAppStore.getState().openGoalDialog())
    await user.type(
      screen.getByRole("textbox", { name: "Goal" }),
      " and test it",
    )
    act(() =>
      useAppStore.setState({
        selectedSession: { ...session, goal: { ...goal, tokensUsed: 800 } },
      }),
    )
    expect(
      (screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Ship the feature and test it")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(fakeRef.current.requestsFor("goal/set")[0]?.params).toEqual({
      sessionId: session.id,
      objective: "Ship the feature and test it",
    })
  })
})
