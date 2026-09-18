// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: undefined,
  })
})

describe("links", () => {
  it("opens external links through the desktop bridge instead of navigating", async () => {
    const openUrl = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openUrl },
    })
    const user = userEvent.setup()
    render(<MarkdownView text="See [the docs](https://example.com/docs)." />)

    await user.click(screen.getByRole("link", { name: "the docs" }))
    expect(openUrl).toHaveBeenCalledWith({ url: "https://example.com/docs" })
  })

  it("opens external links on ctrl+click as well", async () => {
    const openUrl = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openUrl },
    })
    const user = userEvent.setup()
    render(<MarkdownView text="See [the docs](https://example.com/docs)." />)

    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("link", { name: "the docs" }))
    await user.keyboard("{/Control}")
    expect(openUrl).toHaveBeenCalledWith({ url: "https://example.com/docs" })
  })

  it("falls back to window.open without the desktop bridge", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    const user = userEvent.setup()
    render(<MarkdownView text="See [the docs](https://example.com/docs)." />)

    await user.click(screen.getByRole("link", { name: "the docs" }))
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("opens uppercase schemes externally too", async () => {
    const openUrl = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openUrl },
    })
    const user = userEvent.setup()
    render(<MarkdownView text="See [the docs](HTTPS://example.com)." />)

    await user.click(screen.getByRole("link", { name: "the docs" }))
    expect(openUrl).toHaveBeenCalledWith({ url: "HTTPS://example.com" })
  })

  it("opens file links in the editor with their line number", async () => {
    const openFile = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openFile },
    })
    const user = userEvent.setup()
    render(
      <MarkdownView
        text="See [the store](src/core/session.ts:1037)."
        workspaceRoot="/workspaces/app"
      />,
    )

    await user.click(screen.getByRole("link", { name: "the store" }))
    expect(openFile).toHaveBeenCalledWith({
      path: "src/core/session.ts",
      line: 1037,
      workspaceRoot: "/workspaces/app",
    })
  })

  it("never opens non-http scheme links", async () => {
    const openUrl = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openUrl },
    })
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    const user = userEvent.setup()
    render(
      <MarkdownView text="[click](javascript:alert(1)) and [mail](mailto:a@b.c)" />,
    )

    // react-markdown strips the javascript: href, so it renders without a
    // link role at all; only the mailto: anchor is clickable.
    const links = screen.getAllByRole("link")
    expect(links).toHaveLength(1)
    await user.click(links[0] as HTMLElement)
    expect(openUrl).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()
    expect(window.location.href).toContain("http://localhost:3000/")
    const inert = screen.getByText("click")
    expect(inert.getAttribute("href")).toBeNull()
    await user.click(inert)
    expect(openUrl).not.toHaveBeenCalled()
  })
})

describe("code blocks", () => {
  it("renders a plain fallback until the highlighter loads, then highlights known languages", async () => {
    const { container } = render(
      <MarkdownView text={"```ts\nconst answer: number = 42\n```"} />,
    )
    expect(container.querySelector(".shiki")).toBeNull()
    expect(container.querySelector("pre")?.textContent).toContain(
      "const answer",
    )

    await waitFor(() => {
      expect(container.querySelector(".shiki")).not.toBeNull()
    })
    expect(container.querySelector(".shiki")?.textContent).toContain(
      "const answer",
    )
  })

  it("keeps rapid streaming prefixes plain and highlights only the settled code", async () => {
    const { container, rerender } = render(
      <MarkdownView text={"```ts\nconst first = 1\n```"} />,
    )
    await waitFor(() => {
      expect(container.querySelector(".shiki")).not.toBeNull()
    })

    rerender(<MarkdownView text={"```ts\nconst second = 2\n```"} />)
    rerender(<MarkdownView text={"```ts\nconst final = 3\n```"} />)

    expect(container.querySelector(".shiki")).toBeNull()
    expect(container.querySelector("pre")?.textContent).toContain("const final")
    await waitFor(() => {
      expect(container.querySelector(".shiki")?.textContent).toContain(
        "const final",
      )
    })
    expect(container.textContent).not.toContain("const second")
  })

  it("keeps unknown languages plain once the highlighter is ready", async () => {
    const { container } = render(
      <MarkdownView
        text={"```ts\nconst answer = 42\n```\n\n```brainfuck\n++++++++++\n```"}
      />,
    )
    await waitFor(() => {
      expect(container.querySelector(".shiki")).not.toBeNull()
    })
    const blocks = container.querySelectorAll("pre")
    const highlighted = [...blocks].filter((block) =>
      block.className.includes("shiki"),
    )
    expect(highlighted).toHaveLength(1)
    expect(container.textContent).toContain("++++++++++")
  })

  it("leaves inline code unhighlighted", async () => {
    const { container } = render(<MarkdownView text="Run `pnpm dev` first." />)
    const code = container.querySelector("code")
    expect(code?.textContent).toBe("pnpm dev")
    expect(code?.closest(".shiki")).toBeNull()
    expect(container.querySelector("pre")).toBeNull()
  })
})
