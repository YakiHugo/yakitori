// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AssistantMessageCell } from "../../src/gui/components/cells/assistant-message-cell.tsx"
import type { ExecutionEntry } from "../../src/gui/execution-view.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"

const { openUrlTarget, openFileTarget } = vi.hoisted(() => ({
  openUrlTarget: vi.fn(),
  openFileTarget: vi.fn(),
}))
vi.mock("../../src/gui/lib/open-resource.ts", () => ({
  openUrlTarget,
  openFileTarget,
}))

const originalOpenBrowser = useWorkspaceStore.getState().openBrowser
const openBrowser = vi.fn()
const entry: Extract<ExecutionEntry, { kind: "assistant" }> = {
  kind: "assistant",
  itemId: "answer",
  turnId: "turn_1",
  text: "An answer with sources.",
  status: "completed",
  at: "2026-10-05T00:00:00.000Z",
  sources: [
    {
      id: "web",
      label: "Web source",
      url: "https://example.com/source",
      origins: [{ provider: "openai", blockIndex: 0 }],
    },
    {
      id: "file",
      label: "report.pdf",
      origins: [{ provider: "openai", blockIndex: 0 }],
    },
    {
      id: "pages",
      label: "Annual report",
      location: "from page 2",
      origins: [{ provider: "anthropic", blockIndex: 1 }],
    },
  ],
}

beforeEach(() => {
  openUrlTarget.mockReset().mockResolvedValue(undefined)
  openFileTarget.mockReset().mockResolvedValue(undefined)
  openBrowser.mockReset()
  useWorkspaceStore.setState({ openBrowser })
})

afterEach(() => {
  cleanup()
  useWorkspaceStore.setState({ openBrowser: originalOpenBrowser })
})

describe("assistant message sources", () => {
  it("renders source links and non-clickable file/page labels after the answer", () => {
    render(<AssistantMessageCell entry={entry} />)
    const section = screen.getByRole("region", { name: "Sources" })
    expect(screen.getByText("An answer with sources.")).toBeDefined()
    expect(within(section).getAllByRole("listitem")).toHaveLength(3)
    expect(within(section).getAllByRole("link")).toHaveLength(1)
    expect(
      within(section)
        .getByRole("link", { name: "Web source" })
        .getAttribute("href"),
    ).toBe("https://example.com/source")
    expect(within(section).getByText("report.pdf").closest("a")).toBeNull()
    expect(within(section).getByText("Annual report").closest("a")).toBeNull()
    expect(section.textContent).toContain("from page 2")
  })

  it("routes a normal source click to the workspace browser and prevents native navigation", () => {
    render(<AssistantMessageCell entry={entry} />)
    const link = screen.getByRole("link", { name: "Web source" })
    expect(fireEvent.click(link)).toBe(false)
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/source",
    )
    expect(openUrlTarget).not.toHaveBeenCalled()
  })

  it.each([
    "ctrlKey",
    "metaKey",
  ])("routes a %s source click through the existing external opener", (modifier) => {
    render(<AssistantMessageCell entry={entry} />)
    expect(
      fireEvent.click(screen.getByRole("link", { name: "Web source" }), {
        [modifier]: true,
      }),
    ).toBe(false)
    expect(openUrlTarget).toHaveBeenCalledExactlyOnceWith({
      kind: "url",
      url: "https://example.com/source",
    })
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it.each([
    "javascript:alert(1)",
    "https://user:password@example.com/",
    "https://example.com/\npath",
  ])("rejects unsafe URLs even when supplied as normalized props: %j", (url) => {
    render(
      <AssistantMessageCell
        entry={{
          ...entry,
          sources: [{ id: "unsafe", label: "Unsafe source", url, origins: [] }],
        }}
      />,
    )
    const label = screen.getByText("Unsafe source")
    expect(screen.queryByRole("link")).toBeNull()
    fireEvent.click(label)
    expect(openBrowser).not.toHaveBeenCalled()
    expect(openUrlTarget).not.toHaveBeenCalled()
    expect(openFileTarget).not.toHaveBeenCalled()
  })

  it("omits the source section when no sources are available", () => {
    render(<AssistantMessageCell entry={{ ...entry, sources: [] }} />)
    expect(screen.queryByRole("region", { name: "Sources" })).toBeNull()
    expect(screen.getByText("An answer with sources.")).toBeDefined()
  })
})
