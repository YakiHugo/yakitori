// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ToolResultParts } from "../../src/gui/components/cells/tool-result-parts.tsx"
import { rolloutAssetUrl } from "../../src/gui/rollout-asset-url.ts"
import type { ModelToolContentBlock } from "../../src/kernel/events.ts"

const originalDesktop = window.yakitoriDesktop
afterEach(() => {
  cleanup()
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: originalDesktop,
  })
  vi.restoreAllMocks()
})
const image = {
  type: "image" as const,
  mediaType: "image/png" as const,
  name: "captured.png",
  sizeBytes: 42,
  file: { rolloutId: "rollout_1", path: "tools/call_1/captured.png" },
}
const document = {
  type: "document" as const,
  mediaType: "application/pdf" as const,
  name: "report.pdf",
  sizeBytes: 100,
  file: { rolloutId: "rollout_1", path: "tools/call_1/report.pdf" },
}

describe("ordered tool result presentation", () => {
  it("opens PDFs through the desktop bridge and exposes recoverable opener failures", async () => {
    const openUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error("PDF opener unavailable"))
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openUrl },
    })
    const browserOpen = vi.spyOn(window, "open").mockReturnValue(null)
    render(
      <ToolResultParts
        parts={[document]}
        toolCallId="call_1"
        apiBase="http://localhost:1234/"
      />,
    )
    const link = screen.getByRole("link", { name: "Open PDF: report.pdf" })
    expect(fireEvent.click(link)).toBe(false)
    expect((await screen.findByRole("alert")).textContent).toBe(
      "PDF opener unavailable",
    )
    expect(openUrl).toHaveBeenCalledExactlyOnceWith({
      url: "http://localhost:1234/rollouts/rollout_1/assets/tools/call_1/report.pdf",
    })
    expect(browserOpen).not.toHaveBeenCalled()
    fireEvent.click(link)
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    expect(openUrl).toHaveBeenCalledTimes(2)
  })

  it("uses the browser opener with opener isolation outside Electron", () => {
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: undefined,
    })
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    render(
      <ToolResultParts
        parts={[document]}
        toolCallId="call_1"
        apiBase="http://localhost:1234/"
      />,
    )
    expect(
      fireEvent.click(
        screen.getByRole("link", { name: "Open PDF: report.pdf" }),
      ),
    ).toBe(false)
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:1234/rollouts/rollout_1/assets/tools/call_1/report.pdf",
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("renders repeated media and PDF links between their surrounding text without exposing raw payloads", () => {
    const parts: ModelToolContentBlock[] = [
      { type: "text", text: "before" },
      image,
      { type: "text", text: "between" },
      document,
      { type: "text", text: "after PDF" },
      image,
    ]
    render(
      <ToolResultParts
        parts={parts}
        toolCallId="call_1"
        apiBase="http://localhost:1234/base/"
      />,
    )
    const group = screen.getByRole("region", { name: "Ordered tool result" })
    expect([...group.children].map((node) => node.tagName)).toEqual([
      "PRE",
      "IMG",
      "PRE",
      "A",
      "PRE",
      "IMG",
    ])
    expect([...group.children].map((node) => node.textContent)).toEqual([
      "before",
      "",
      "between",
      "Open PDF: report.pdf",
      "after PDF",
      "",
    ])
    expect(screen.getAllByRole("img", { name: "captured.png" })).toHaveLength(2)
    const link = screen.getByRole("link", { name: "Open PDF: report.pdf" })
    expect(link.getAttribute("href")).toBe(
      "http://localhost:1234/base/rollouts/rollout_1/assets/tools/call_1/report.pdf",
    )
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
    expect(group.textContent).not.toContain("rollout_1")
  })

  it("shows an unavailable label for invalid asset references rather than creating a navigation", () => {
    render(
      <ToolResultParts
        parts={[
          {
            ...document,
            file: { rolloutId: "rollout_1", path: "tools/../../settings" },
          },
        ]}
        toolCallId="call_1"
        apiBase="http://localhost:1234/"
      />,
    )
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("PDF preview unavailable")).toBeTruthy()
  })

  it.each([
    "tools/../report.pdf",
    "tools/./report.pdf",
    "tools/\\report.pdf",
    "tools/one/\nreport.pdf",
    "other/call/report.pdf",
  ])("rejects a path outside the asset contract: %j", (path) => {
    expect(
      rolloutAssetUrl(
        { rolloutId: "rollout_1", path },
        "http://localhost:1234/",
      ),
    ).toBeUndefined()
  })

  it.each([
    "javascript:alert(1)",
    "file:///tmp/",
    "https://name:secret@example.org/",
    "invalid",
  ])("rejects an unsafe API base %s", (base) => {
    expect(rolloutAssetUrl(document.file, base)).toBeUndefined()
  })

  it("encodes literal filename characters and rejects a traversal owner", () => {
    expect(
      rolloutAssetUrl(
        { rolloutId: "rollout_1", path: "tools/call/a #?.pdf" },
        "http://localhost:1234/base",
      ),
    ).toBe(
      "http://localhost:1234/base/rollouts/rollout_1/assets/tools/call/a%20%23%3F.pdf",
    )
    expect(
      rolloutAssetUrl(
        { rolloutId: "..", path: "tools/call/a.pdf" },
        "http://localhost:1234/",
      ),
    ).toBeUndefined()
  })
})
