// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"
import { CopyIconButton } from "../../src/gui/components/response-actions.tsx"
import { writeClipboardText } from "../../src/gui/lib/clipboard.ts"
import { openFileTarget } from "../../src/gui/lib/open-resource.ts"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: undefined,
  })
})

function desktop(writeClipboardText: (text: string) => Promise<void>) {
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { writeClipboardText },
  })
}

describe("GUI copy operations", () => {
  it("uses the native bridge and only confirms copying after its ACK", async () => {
    const user = userEvent.setup()
    const webWrite = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(
        new DOMException("Write permission denied", "NotAllowedError"),
      )
    let acknowledge!: () => void
    const nativeWrite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve
        }),
    )
    desktop(nativeWrite)
    render(
      <CopyIconButton
        text={"Exact message\nwith another line"}
        label="response"
      />,
    )
    await user.click(screen.getByRole("button", { name: "Copy response" }))
    expect(nativeWrite).toHaveBeenCalledWith("Exact message\nwith another line")
    expect(webWrite).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "Copy response" }),
    ).toHaveProperty("disabled", true)
    expect(screen.queryByRole("button", { name: "Copied response" })).toBeNull()
    await act(async () => acknowledge())
    expect(
      screen.getByRole("button", { name: "Copied response" }),
    ).toHaveProperty("disabled", false)
  })

  it("reports a native rejection without falling back to renderer permissions and permits retry", async () => {
    const user = userEvent.setup()
    const webWrite = vi.spyOn(navigator.clipboard, "writeText")
    const nativeWrite = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC clipboard unavailable"))
      .mockResolvedValueOnce(undefined)
    desktop(nativeWrite)
    render(<CopyIconButton text="retry me" label="message" />)
    await user.click(screen.getByRole("button", { name: "Copy message" }))
    expect(screen.getByRole("status").textContent).toContain("Could not copy")
    expect(webWrite).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Copy message" }))
    expect(screen.getByRole("button", { name: "Copied message" })).toBeDefined()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("copies raw fenced code including indentation and its final newline", async () => {
    const user = userEvent.setup()
    const nativeWrite = vi.fn(async () => {})
    desktop(nativeWrite)
    const view = render(
      <MarkdownView text={"```unknown\n  hello <world>\nnext line\n```"} />,
    )
    await user.click(screen.getByRole("button", { name: "Copy code" }))
    expect(nativeWrite).toHaveBeenCalledWith("  hello <world>\nnext line\n")
    expect(screen.getByRole("button", { name: "Copied code" })).toBeDefined()
    expect(view.container.textContent).toBe("  hello <world>\nnext line\n")
  })

  it("copies resolved file paths through the browser fallback", async () => {
    userEvent.setup()
    const webWrite = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue()
    await openFileTarget(
      { kind: "file", path: "./src/main.ts", line: 42 },
      "/workspace/project/",
    )
    expect(webWrite).toHaveBeenCalledWith("/workspace/project/src/main.ts:42")
  })

  it("handles denied browser writes and missing clipboard support without unhandled rejection", async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Denied", "NotAllowedError"),
    )
    render(<CopyIconButton text="browser copy" label="response" />)
    await user.click(screen.getByRole("button", { name: "Copy response" }))
    expect(screen.getByRole("status").textContent).toContain("Could not copy")
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue(
      undefined as unknown as Clipboard,
    )
    await expect(writeClipboardText("unavailable")).rejects.toThrow(
      "Clipboard is unavailable",
    )
  })
})
