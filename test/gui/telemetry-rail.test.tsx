// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, expect, it } from "vitest"
import { TelemetryRail } from "../../src/gui/components/telemetry-rail.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { reduceExecutionView } from "../../src/gui/execution-view.ts"
import { createEventEnvelope } from "../../src/kernel/events.ts"

afterEach(() => {
  cleanup()
  useAppStore.setState(createInitialAppState())
})

it("restores replayed session metrics and pairs TPS with the completed turn during live usage updates", async () => {
  const user = userEvent.setup()
  useAppStore.setState(createInitialAppState())
  useAppStore.setState((state) => ({
    execution: reduceExecutionView(state.execution, {
      type: "durable",
      event: createEventEnvelope({
        sessionId: "session-metrics",
        seq: 1,
        event: {
          type: "turn.completed",
          data: {
            turnId: "turn-1",
            outcome: { status: "completed" },
            usage: {
              inputTokens: 1_000,
              outputTokens: 200,
              cacheReadInputTokens: 750,
              cacheWriteInputTokens: 100,
            },
            metrics: {
              modelCalls: 2,
              toolCalls: 1,
              modelDurationMs: 4_000,
              toolDurationMs: 500,
              averageTimeToFirstTokenMs: 250,
            },
          },
        },
      }),
    }),
  }))
  render(<TelemetryRail />)
  const summary = screen.getByText("Avg TTFT").closest("summary")
  expect(summary?.textContent).toContain("Avg TTFT 250ms")
  expect(summary?.textContent).toContain("Tokens 1.2K")
  expect(summary?.textContent).toContain("Cache hit 75.0%")
  expect(summary?.textContent).toContain("TPS 50.0")
  await user.click(screen.getByText("Tokens"))
  const details = screen.getByRole("region", { name: "Session metrics" })
  expect(within(details).getByText("1,000")).toBeDefined()
  expect(within(details).getByText("200")).toBeDefined()
  expect(within(details).getByText("750")).toBeDefined()
  expect(within(details).getByText("100")).toBeDefined()
  act(() =>
    useAppStore.setState((state) => ({
      execution: reduceExecutionView(state.execution, {
        type: "transient",
        event: {
          type: "session.usage",
          sessionId: "session-metrics",
          turnId: "turn-2",
          createdAt: "2026-09-20T12:00:00Z",
          usage: {
            inputTokens: 2_000,
            outputTokens: 600,
            cacheReadInputTokens: 1_000,
          },
        },
      }),
    })),
  )
  expect(summary?.textContent).toContain("Tokens 2.6K")
  expect(summary?.textContent).toContain("Cache hit 50.0%")
  expect(summary?.textContent).toContain("TPS 50.0")
})

it("shows unavailable timing without reusing measurements from a previous turn", () => {
  useAppStore.setState(createInitialAppState())
  render(<TelemetryRail />)
  const summary = screen.getByText("Avg TTFT").closest("summary")
  expect(summary?.textContent).toContain("Avg TTFT —")
  expect(summary?.textContent).toContain("Cache hit —")
  expect(summary?.textContent).toContain("TPS —")
  act(() =>
    useAppStore.setState((state) => ({
      execution: reduceExecutionView(
        {
          ...state.execution,
          lastTurnUsage: { inputTokens: 10, outputTokens: 20 },
          lastTurnMetrics: {
            modelCalls: 1,
            toolCalls: 0,
            modelDurationMs: 1_000,
            toolDurationMs: 0,
          },
        },
        {
          type: "durable",
          event: createEventEnvelope({
            sessionId: "session-metrics",
            seq: 1,
            event: {
              type: "turn.completed",
              data: {
                turnId: "turn-2",
                outcome: { status: "completed" },
                usage: { inputTokens: 100, outputTokens: 100 },
              },
            },
          }),
        },
      ),
    })),
  )
  expect(summary?.textContent).toContain("TPS —")
})
