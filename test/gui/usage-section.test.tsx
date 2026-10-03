// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ThreadUsageSummary } from "../../src/core/sqlite-thread-usage-projection.ts"
import { UsageSection } from "../../src/gui/components/usage-section.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  emptyUsage,
  totalTokens,
  usageCalendar,
  usageView,
} from "../../src/gui/usage-view.ts"

const latest = {
  ...emptyUsage,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 60,
  cacheWriteInputTokens: 10,
  turns: 2,
}
const older = { ...emptyUsage, inputTokens: 200, outputTokens: 80, turns: 1 }
const summary: ThreadUsageSummary = {
  generatedAt: "2026-10-02T18:00:00Z",
  totals: {
    ...emptyUsage,
    inputTokens: 1300,
    outputTokens: 100,
    turns: 4,
    cacheReadInputTokens: 60,
    cacheWriteInputTokens: 10,
  },
  days: [
    { ...older, date: "2026-09-01" },
    { ...latest, date: "2026-10-02" },
  ],
  models: [
    { ...latest, provider: "codex", model: "example" },
    { ...older, provider: "other", model: "example" },
    {
      ...emptyUsage,
      inputTokens: 1000,
      turns: 1,
      provider: "legacy",
      model: "old",
    },
  ],
  modelDays: [
    { ...latest, date: "2026-10-02", provider: "codex", model: "example" },
    { ...older, date: "2026-09-01", provider: "other", model: "example" },
  ],
  threads: [
    {
      ...latest,
      threadId: "a",
      title: "Conversation",
      updatedAt: "2026-10-02T18:00:00Z",
      totalTokens: 120,
    },
  ],
}

beforeEach(() =>
  useAppStore.setState({
    ...createInitialAppState(),
    usage: { summary, loading: false },
  }),
)
afterEach(cleanup)

describe("usage periods", () => {
  it("zero-fills UTC calendar days including leap day, without counting cache twice", () => {
    const days = usageCalendar(
      { ...summary, generatedAt: "2024-03-01T00:01:00Z" },
      3,
    )
    expect(days.map((day) => day.date)).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ])
    expect(days.map((day) => day.turns)).toEqual([0, 0, 0])
    expect(totalTokens(latest)).toBe(120)
  })
  it("filters totals and same-named provider models together, preserving all-time history", () => {
    expect(usageView(summary, 30).totals).toEqual(latest)
    expect(
      usageView(summary, 90).models.map((model) => model.provider),
    ).toEqual(["other", "codex"])
    expect(usageView(summary, "all").totals.inputTokens).toBe(1300)
    expect(usageView(summary, 366, "2026-09-01").totals).toEqual(older)
    expect(usageView(summary, 30, "2026-09-30").totals).toEqual(emptyUsage)
  })
})

describe("usage dashboard", () => {
  it("changes periods, drills into heatmap days and clears the filter without changing all-time conversations", () => {
    render(<UsageSection />)
    const models = screen.getByRole("region", { name: "Usage by model" })
    expect(within(models).getByText("codex")).toBeTruthy()
    expect(within(models).queryByText("other")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "90D" }))
    expect(within(models).getByText("other")).toBeTruthy()
    const activity = screen.getByRole("region", { name: "Activity heatmap" })
    const day = within(activity).getByRole("button", {
      name: "2026-09-01: 280 tokens, 1 turns",
    })
    fireEvent.click(day)
    expect(within(models).queryByText("codex")).toBeNull()
    expect(screen.getByRole("cell", { name: "Conversation" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Clear day filter" }))
    expect(within(models).getByText("codex")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "All time" }))
    expect(within(models).getByText("legacy")).toBeTruthy()
  })
  it("provides keyboard heatmap navigation and exact token labels", () => {
    render(<UsageSection />)
    const activity = screen.getByRole("region", { name: "Activity heatmap" })
    const today = within(activity).getByRole("button", {
      name: "2026-10-02: 120 tokens, 2 turns",
    })
    today.focus()
    fireEvent.keyDown(today, { key: "ArrowUp" })
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "2026-10-01: 0 tokens, 0 turns",
    )
    expect(screen.getByText("60.0%")).toBeTruthy()
  })
  it("retains data on refresh error and disables repeated refresh while loading", () => {
    const refresh = vi.fn()
    useAppStore.setState({
      usage: { summary, loading: true, error: "Offline" },
      loadUsage: refresh,
    })
    render(<UsageSection />)
    expect(screen.getByRole("alert").textContent).toContain(
      "Showing the previous result",
    )
    const button = screen.getByRole("button", {
      name: "Refresh usage",
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(refresh).not.toHaveBeenCalled()
  })
  it("distinguishes unavailable data from a successfully loaded empty period", () => {
    useAppStore.setState({ usage: { loading: true } })
    const view = render(<UsageSection />)
    expect(screen.getByRole("status").textContent).toBe("Loading usage…")
    view.unmount()
    useAppStore.setState({
      usage: {
        summary: {
          ...summary,
          totals: emptyUsage,
          days: [],
          models: [],
          modelDays: [],
          threads: [],
        },
        loading: false,
      },
    })
    render(<UsageSection />)
    expect(screen.getByText(/No recorded usage in this period/)).toBeTruthy()
    expect(screen.queryByText("NaN")).toBeNull()
  })
})

describe("usage overview and breakdown", () => {
  it("compares model shares within the selected period without counting cached input twice", () => {
    useAppStore.setState({
      usage: {
        loading: false,
        summary: {
          ...summary,
          modelDays: [
            ...summary.modelDays,
            {
              ...emptyUsage,
              provider: "codex",
              model: "second",
              date: "2026-10-02",
              inputTokens: 30,
              outputTokens: 10,
              turns: 1,
            },
          ],
          days: [
            {
              ...latest,
              date: "2026-10-02",
              inputTokens: 130,
              outputTokens: 30,
              turns: 3,
            },
          ],
        },
      },
    })
    render(<UsageSection />)
    const models = screen.getByRole("region", { name: "Usage by model" })
    expect(within(models).getAllByRole("listitem")).toHaveLength(2)
    expect(within(models).getByText("75.0%")).toBeTruthy()
    expect(within(models).getByText("25.0%")).toBeTruthy()
    expect(within(models).getByText("120")).toBeTruthy()
    expect(within(models).getByText("40")).toBeTruthy()
    expect(screen.getByText("160 total tokens")).toBeTruthy()
  })
  it("shows exact daily totals including zero days, supports drill-down and labels the limited all-time chart window", () => {
    render(<UsageSection />)
    fireEvent.click(screen.getByText("Usage details"))
    fireEvent.click(screen.getByRole("button", { name: "Day" }))
    let daily = screen.getByRole("region", { name: "Usage by day" })
    expect(within(daily).getAllByRole("row")).toHaveLength(31)
    const today = within(daily).getByRole("button", { name: "2026-10-02" })
    expect(today.closest("tr")?.textContent).toBe("2026-10-0221002060120")
    fireEvent.click(today)
    expect(within(daily).getAllByRole("row")).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Clear day filter" }))
    expect(within(daily).getAllByRole("row")).toHaveLength(31)
    fireEvent.click(screen.getByRole("button", { name: "All time" }))
    daily = screen.getByRole("region", { name: "Usage by day" })
    expect(within(daily).getByText("Last 30 days · UTC")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Model" }))
    expect(
      screen.getByRole("region", { name: "Usage by model" }).textContent,
    ).toContain("legacy")
  })
})

it("keeps secondary metrics collapsed and preserves access to every model beyond the concise comparison", () => {
  const models = Array.from({ length: 7 }, (_, index) => ({
    ...latest,
    provider: "codex",
    model: `model-${index}`,
  }))
  useAppStore.setState({
    usage: { loading: false, summary: { ...summary, models } },
  })
  render(<UsageSection />)
  fireEvent.click(screen.getByRole("button", { name: "All time" }))
  const comparison = screen.getByRole("region", { name: "Usage by model" })
  expect(within(comparison).getAllByRole("listitem")).toHaveLength(5)
  expect(within(comparison).getByText("Top 5 of 7")).toBeTruthy()
  const disclosure = screen.getByText("Usage details").closest("details")
  expect(disclosure?.open).toBe(false)
  fireEvent.click(screen.getByText("Usage details"))
  expect(disclosure?.open).toBe(true)
  const details = screen.getByRole("region", { name: "Detailed model usage" })
  expect(within(details).getAllByRole("row")).toHaveLength(8)
  fireEvent.click(screen.getByText("Usage details"))
  expect(disclosure?.open).toBe(false)
})
