// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApprovalBar } from "../../src/gui/components/approval-bar.tsx"
import {
  createExecutionViewState,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { LiveSessionEvent } from "../../src/runtime/live-events.ts"

const sessionId = "session_1"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("approval bar", () => {
  it("renders nothing when no permission is pending", () => {
    const { container } = render(<ApprovalBar />)
    expect(container.firstChild).toBeNull()
  })

  it("routes allow and deny clicks through the store action", async () => {
    const user = userEvent.setup()
    const resolvePermission = vi.fn(
      (
        _turnId: string,
        _permissionRequestId: string,
        _behavior: "allow" | "deny",
      ) => Promise.resolve(),
    )
    useAppStore.setState({
      execution: seedExecution([
        {
          type: "permission.requested",
          sessionId,
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "tool_1",
          action: "read_file",
          subject: "/tmp/result.log",
          reason: "This tool will read a path outside the selected workspace.",
          createdAt: "2026-08-25T00:00:00.000Z",
        },
      ]),
      resolvePermission,
    })
    render(<ApprovalBar />)

    expect(
      screen.getByText(
        "This tool will read a path outside the selected workspace.",
      ),
    ).not.toBeNull()

    await user.click(screen.getByRole("button", { name: "Allow" }))
    expect(resolvePermission).toHaveBeenCalledWith(
      "turn_1",
      "permission_1",
      "allow",
    )

    await user.click(screen.getByRole("button", { name: "Deny" }))
    expect(resolvePermission).toHaveBeenCalledWith(
      "turn_1",
      "permission_1",
      "deny",
    )
  })

  it("disappears once the permission is resolved", () => {
    useAppStore.setState({
      execution: seedExecution([
        {
          type: "permission.requested",
          sessionId,
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "tool_1",
          action: "run_command",
          createdAt: "2026-08-25T00:00:00.000Z",
        },
        {
          type: "permission.resolved",
          sessionId,
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          outcome: "allow",
          createdAt: "2026-08-25T00:00:01.000Z",
        },
      ]),
    })
    const { container } = render(<ApprovalBar />)
    expect(container.firstChild).toBeNull()
  })
})

function seedExecution(events: LiveSessionEvent[]) {
  return events.reduce(
    (current, event) =>
      reduceExecutionView(current, {
        type: "transient",
        event,
      }),
    createExecutionViewState(),
  )
}
