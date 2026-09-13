// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { App } from "../../src/gui/app.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("app shell", () => {
  it("does not expose an API server switcher", () => {
    render(<App />)

    expect(screen.queryByRole("textbox", { name: "API" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull()
  })

  it("shows the session telemetry bar without requiring a tooltip", () => {
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      selectedSession: {
        id: "session_1",
        conversationId: "conversation_1",
        projectId: "project_1",
        title: "Session",
        createdAt: "2026-09-12T00:00:00Z",
        updatedAt: "2026-09-12T00:00:00Z",
        seq: 1,
        pendingInputs: [],
        pendingPermissions: [],
        counts: {
          turns: 1,
          inputs: 1,
          tools: 0,
          pendingInputs: 0,
          items: 0,
          permissions: 0,
        },
      },
    })
    render(<App />)

    expect(
      screen.getByRole("status", { name: "Session telemetry" }),
    ).toBeDefined()
  })
})
