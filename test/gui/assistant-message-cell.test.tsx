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
import { TooltipProvider } from "../../src/gui/components/ui/tooltip.tsx"
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
    },
    {
      id: "file",
      label: "report.pdf",
    },
    {
      id: "pages",
      label: "Annual report",
      location: "from page 2",
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
  it("places repeated markers at Markdown text boundaries and previews the source quote on focus", async () => {
    const text = "A &amp; B \\*C\\* [link](https://example.test/) tail."
    const { container } = render(
      <TooltipProvider>
        <AssistantMessageCell
          sessionId="work"
          apiBase="http://localhost"
          entry={{
            ...entry,
            text,
            sources: [
              {
                ...entry.sources?.[0],
                id: "web",
                label: "Web source",
                mentions: [
                  {
                    responseSpan: { start: 0, end: 9 },
                    citedText: "From the original source.",
                  },
                  { responseSpan: { start: 17, end: 20 } },
                ],
              },
            ],
          }}
        />
      </TooltipProvider>,
    )
    expect(container.querySelector(".markdown p")?.textContent).toBe(
      "A & B[1] *C* link[1] tail.",
    )
    const markers = screen.getAllByRole("link", {
      name: "Citation 1, Web source",
    })
    expect(markers).toHaveLength(2)
    expect(markers[1]?.parentElement?.previousElementSibling?.textContent).toBe(
      "link",
    )
    const marker = markers[0]
    if (marker === undefined) throw new Error("Missing inline citation.")
    fireEvent.focus(marker)
    const preview = await screen.findByRole("tooltip")
    expect(preview.textContent).toContain("Web source")
    expect(preview.textContent).toContain("From the original source.")
    expect(fireEvent.click(marker)).toBe(false)
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/source",
    )
  })

  it("focuses the matching Sources row when a cited document has no web URL", () => {
    render(
      <TooltipProvider>
        <AssistantMessageCell
          sessionId="work"
          apiBase="http://localhost"
          entry={{
            ...entry,
            sources: [
              {
                id: "file",
                label: "Report",
                mentions: [{ responseSpan: { start: 0, end: 9 } }],
              },
              { id: "unplaced", label: "Unplaced source" },
            ],
          }}
        />
      </TooltipProvider>,
    )
    const marker = screen.getByRole("button", { name: "Citation 1, Report" })
    fireEvent.click(marker)
    const sources = screen.getByRole("region", { name: "Sources" })
    expect(document.activeElement).toBe(
      within(sources).getByText("Report").closest("li"),
    )
    expect(within(sources).getByText("Unplaced source")).toBeDefined()
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it("renders source links and non-clickable file/page labels after the answer", () => {
    render(
      <AssistantMessageCell
        sessionId="work"
        apiBase="http://localhost"
        entry={entry}
      />,
    )
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
    render(
      <AssistantMessageCell
        sessionId="work"
        apiBase="http://localhost"
        entry={entry}
      />,
    )
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
    render(
      <AssistantMessageCell
        sessionId="work"
        apiBase="http://localhost"
        entry={entry}
      />,
    )
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
        sessionId="work"
        apiBase="http://localhost"
        entry={{
          ...entry,
          sources: [{ id: "unsafe", label: "Unsafe source", url }],
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
    render(
      <AssistantMessageCell
        sessionId="work"
        apiBase="http://localhost"
        entry={{ ...entry, sources: [] }}
      />,
    )
    expect(screen.queryByRole("region", { name: "Sources" })).toBeNull()
    expect(screen.getByText("An answer with sources.")).toBeDefined()
  })
})
