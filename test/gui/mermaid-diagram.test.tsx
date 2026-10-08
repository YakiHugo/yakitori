import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { conversationFindRanges } from "../../src/gui/components/conversation-find-text.ts"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render:
    vi.fn<
      (
        id: string,
        source: string,
        container?: Element,
      ) => Promise<{ svg: string }>
    >(),
}))
vi.mock("mermaid", () => ({ default: mermaid }))

const source = "flowchart LR\n  A[Start] --> B[Finish]\n"
const markdown = `\`\`\`mermaid\n${source}\`\`\``
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" width="100%"><text>Start and Finish</text></svg>'

beforeEach(() => {
  mermaid.initialize.mockReset()
  mermaid.render.mockReset().mockResolvedValue({ svg })
  document.documentElement.classList.remove("dark")
})
afterEach(() => {
  cleanup()
  document.body.style.backgroundColor = ""
})

describe("Mermaid markdown", () => {
  it("finds source text exactly once without matching diagram controls or error messages", async () => {
    const user = userEvent.setup()
    const text = "```mermaid\nflowchart LR\nA[Mermaid]\n```"
    const { container, rerender } = render(<MarkdownView text={text} />)
    expect(conversationFindRanges(container, "Mermaid")).toHaveLength(1)
    await screen.findByRole("img", { name: "Mermaid diagram" })
    expect(conversationFindRanges(container, "Mermaid")).toHaveLength(0)
    await user.click(
      screen.getByRole("button", { name: "Show Mermaid source" }),
    )
    expect(
      conversationFindRanges(container, "Mermaid").map((range) =>
        range.toString(),
      ),
    ).toEqual(["Mermaid"])
    mermaid.render.mockRejectedValueOnce(new Error("Parse error: Mermaid"))
    rerender(<MarkdownView text={"```mermaid\ninvalid Mermaid source\n```"} />)
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Parse error: Mermaid",
      ),
    )
    expect(
      conversationFindRanges(container, "Mermaid").map((range) =>
        range.toString(),
      ),
    ).toEqual(["Mermaid"])
  })

  it.each([
    { shape: "wide", width: 9600, height: 4800, fitted: 720, zoomed: 900 },
    { shape: "tall", width: 4800, height: 9600, fitted: 292, zoomed: 365 },
  ])("fits a $shape diagram inside the padded viewer, expands and resets on reopen", async ({
    width,
    height,
    fitted,
    zoomed,
  }) => {
    const user = userEvent.setup()
    mermaid.render.mockResolvedValue({
      svg: svg.replace("640 240", `${width} ${height}`),
    })
    document.body.style.backgroundColor = "rgb(255, 255, 255)"
    const { container } = render(<MarkdownView text={markdown} />)
    const image = await screen.findByRole("img", { name: "Mermaid diagram" })
    expect(decodeURIComponent(image.getAttribute("src") ?? "")).toContain(
      "background-color:rgb(255, 255, 255)",
    )
    await user.click(
      screen.getByRole("button", { name: "Expand Mermaid diagram" }),
    )
    const dialog = screen.getByRole("dialog", {
      name: "Preview Mermaid diagram",
    })
    expect(container.contains(dialog)).toBe(false)
    const expanded = within(dialog).getByRole("img", {
      name: "Mermaid diagram",
    })
    Object.defineProperties(expanded, {
      naturalWidth: { value: width },
      naturalHeight: { value: height },
    })
    const viewport = expanded.parentElement
    if (!viewport) throw new Error("Missing preview viewport")
    Object.defineProperties(viewport, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    })
    viewport.style.padding = "0px 40px 16px"
    fireEvent.load(expanded)
    expect(expanded.style.width).toBe(`${fitted}px`)
    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }))
    expect(expanded.style.width).toBe(`${zoomed}px`)
    expect(expanded.style.maxWidth).toBe("none")
    await user.click(
      within(dialog).getByRole("button", { name: "Actual size" }),
    )
    expect(expanded.style.width).toBe(`${width}px`)
    await user.click(within(dialog).getByRole("button", { name: "Reset zoom" }))
    expect(expanded.style.width).toBe(`${fitted}px`)
    expect(conversationFindRanges(document.body, "Mermaid")).toHaveLength(0)
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
    await user.click(
      screen.getByRole("button", { name: "Expand Mermaid diagram" }),
    )
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe(
      "100%",
    )
    await user.click(screen.getByRole("button", { name: "Close preview" }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("renders a diagram with intrinsic dimensions and keeps copyable source accessible", async () => {
    const user = userEvent.setup()
    const clipboard = vi.spyOn(navigator.clipboard, "writeText")
    render(<MarkdownView text={markdown} />)
    const image = await screen.findByRole("img", { name: "Mermaid diagram" })
    const imageSvg = decodeURIComponent(
      image.getAttribute("src")?.split(",")[1] ?? "",
    )
    expect(imageSvg).toContain('width="640"')
    expect(imageSvg).toContain('height="240"')
    expect(imageSvg).toContain("Start and Finish")
    await user.click(
      screen.getByRole("button", { name: "Copy Mermaid source" }),
    )
    expect(clipboard).toHaveBeenCalledWith(source)
    await user.click(
      screen.getByRole("button", { name: "Show Mermaid source" }),
    )
    expect(screen.queryByRole("img")).toBeNull()
    expect(document.querySelector("pre")?.textContent).toBe(source)
    await user.click(
      screen.getByRole("button", { name: "Show Mermaid diagram" }),
    )
    expect(screen.getByRole("img", { name: "Mermaid diagram" })).toBeTruthy()
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })

  it("leaves incomplete and completed fences as source until streaming finishes", async () => {
    const { container, rerender } = render(
      <MarkdownView text={"```mermaid\nflowchart LR\nA["} streaming />,
    )
    expect(container.querySelector("pre")?.textContent).toContain("A[")
    rerender(<MarkdownView text={markdown} streaming />)
    await act(async () => {})
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(screen.queryByRole("img")).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
    rerender(<MarkdownView text={markdown} />)
    await screen.findByRole("img", { name: "Mermaid diagram" })
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })

  it("recognizes case-insensitive nested Mermaid fences but leaves ordinary code alone", async () => {
    const text =
      "> ~~~Mermaid title\n> sequenceDiagram\n> A->>B: Hello\n> ~~~\n\n```text\nmermaid\n```"
    const { container } = render(<MarkdownView text={text} />)
    await screen.findByRole("img", { name: "Mermaid diagram" })
    expect(mermaid.render.mock.calls[0]?.[1]).toBe(
      "sequenceDiagram\nA->>B: Hello\n",
    )
    expect(container.querySelector("pre")?.textContent).toBe("mermaid\n")
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })

  it("keeps failed diagram source visible and allows a later attempt to recover", async () => {
    const user = userEvent.setup()
    mermaid.render.mockRejectedValueOnce(new Error("Parse error on line 2"))
    const { container } = render(<MarkdownView text={markdown} />)
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Could not render Mermaid diagram. Parse error on line 2",
      ),
    )
    expect(container.querySelector("pre")?.textContent).toBe(source)
    expect(screen.queryByRole("img")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Retry diagram" }))
    await screen.findByRole("img", { name: "Mermaid diagram" })
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("rerenders on theme change without losing the source toggle", async () => {
    const user = userEvent.setup()
    render(<MarkdownView text={markdown} />)
    await screen.findByRole("img", { name: "Mermaid diagram" })
    await user.click(
      screen.getByRole("button", { name: "Show Mermaid source" }),
    )
    act(() => document.documentElement.classList.add("dark"))
    await waitFor(() =>
      expect(mermaid.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "dark", darkMode: true }),
      ),
    )
    await screen.findByRole("button", { name: "Show Mermaid diagram" })
    expect(screen.queryByRole("img")).toBeNull()
    expect(document.querySelector("pre")?.textContent).toBe(source)
  })

  it("serializes renders, ignores replaced results, and cleans temporary DOM after unmount", async () => {
    const pending = Promise.withResolvers<{ svg: string }>()
    let temporary: Element | undefined
    mermaid.render.mockImplementationOnce(async (_id, _source, container) => {
      temporary = container
      return pending.promise
    })
    const { rerender, unmount } = render(<MarkdownView text={markdown} />)
    await waitFor(() => expect(temporary?.isConnected).toBe(true))
    rerender(
      <MarkdownView text={"```mermaid\nsequenceDiagram\nA->>B: Latest\n```"} />,
    )
    expect(screen.queryByRole("img")).toBeNull()
    await act(async () => {})
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => pending.resolve({ svg }))
    await waitFor(() => expect(temporary?.isConnected).toBe(false))
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(document.querySelector("[aria-hidden=true]")).toBeNull()
    render(<MarkdownView text={markdown} />)
    await screen.findByRole("img", { name: "Mermaid diagram" })
    expect(mermaid.render.mock.calls[1]?.[0]).not.toBe(
      mermaid.render.mock.calls[0]?.[0],
    )
  })

  it("displays only the latest source when an old asynchronous render completes", async () => {
    const pending = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(pending.promise)
    const { container, rerender } = render(<MarkdownView text={markdown} />)
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    rerender(
      <MarkdownView
        text={"```mermaid\nsequenceDiagram\nA->>B: Latest"}
        streaming
      />,
    )
    await act(async () => pending.resolve({ svg }))
    expect(screen.queryByRole("img")).toBeNull()
    expect(container.querySelector("pre")?.textContent).toContain("Latest")
    expect(container.textContent).not.toContain("Start")
  })
})
