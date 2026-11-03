// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"

beforeEach(() => {
  useWorkspaceStore.setState({
    tabs: [],
    sessionId: undefined,
    presentationBySession: {
      "": { open: false, expanded: false, activeId: undefined },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useWorkspaceStore.setState({
    tabs: [],
    sessionId: undefined,
    presentationBySession: {
      "": { open: false, expanded: false, activeId: undefined },
    },
  })
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: undefined,
  })
})

it("renders strong CJK text ending in punctuation before an adjacent sentence", () => {
  const { container } = render(
    <MarkdownView text="**会变化，但两家变化的层级不一样。**截至" />,
  )
  expect(container.querySelector("strong")?.textContent).toBe(
    "会变化，但两家变化的层级不一样。",
  )
  expect(container.textContent).toBe("会变化，但两家变化的层级不一样。截至")
})

describe("links", () => {
  it("loads site icons without changing link names and keeps failed icons actionable", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MarkdownView text="[Documentation](https://example.com/docs)" />,
    )
    const link = screen.getByRole("link", { name: "Documentation" })
    const image = container.querySelector("img")
    expect(image?.getAttribute("src")).toBe("https://example.com/favicon.ico")
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(image?.closest('[aria-hidden="true"]')).not.toBeNull()
    if (!image) throw new Error("Missing site icon")
    fireEvent.error(image)
    expect(container.querySelector("img")).toBeNull()
    expect(link.querySelector("svg")).not.toBeNull()
    await user.click(link)
    expect(useWorkspaceStore.getState().tabs).toEqual([
      expect.objectContaining({
        kind: "browser",
        initialUrl: "https://example.com/docs",
      }),
    ])
  })

  it("opens web links in workspace browser tabs", async () => {
    const openUrl = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openUrl },
    })
    const user = userEvent.setup()
    render(<MarkdownView text="See [the docs](https://example.com/docs)." />)

    await user.click(screen.getByRole("link", { name: "the docs" }))
    expect(openUrl).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().tabs).toEqual([
      expect.objectContaining({
        kind: "browser",
        initialUrl: "https://example.com/docs",
      }),
    ])
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

    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("link", { name: "the docs" }))
    await user.keyboard("{/Control}")
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("routes uppercase web schemes to the workspace too", async () => {
    const openUrl = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openUrl },
    })
    const user = userEvent.setup()
    render(<MarkdownView text="See [the docs](HTTPS://example.com)." />)

    await user.click(screen.getByRole("link", { name: "the docs" }))
    expect(openUrl).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().tabs).toEqual([
      expect.objectContaining({
        kind: "browser",
        initialUrl: "HTTPS://example.com",
      }),
    ])
  })

  it("opens files alongside the conversation and uses the editor on modifier click", async () => {
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
    expect(openFile).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().tabs).toEqual([
      expect.objectContaining({
        kind: "file",
        path: "src/core/session.ts",
        cwd: "/workspaces/app",
      }),
    ])
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("link", { name: "the store" }))
    await user.keyboard("{/Control}")
    expect(openFile).toHaveBeenCalledWith({
      path: "src/core/session.ts",
      line: 1037,
      workspaceRoot: "/workspaces/app",
    })
  })

  it("marks file links with a language glyph and a line suffix", () => {
    render(
      <MarkdownView
        text="See [the store](src/core/session.ts:1037)."
        workspaceRoot="/repo"
      />,
    )
    const link = screen.getByRole("link", { name: "the store" })
    expect(link.querySelector("[data-language='typescript']")).not.toBeNull()
    expect(link.textContent).toContain(":1037")
  })

  it("renders the official language logo for known file types", () => {
    render(
      <MarkdownView
        text="See [the store](src/core/session.ts:1037)."
        workspaceRoot="/repo"
      />,
    )
    const link = screen.getByRole("link", { name: "the store" })
    expect(link.querySelector("svg path")?.getAttribute("fill")).toBe("#3178C6")
  })

  it("does not repeat the line when the link label already carries it", () => {
    render(
      <MarkdownView
        text="See [src/core/session.ts:1037](src/core/session.ts:1037)."
        workspaceRoot="/repo"
      />,
    )
    const link = screen.getByRole("link", {
      name: "src/core/session.ts:1037",
    })
    expect(link.textContent?.match(/:1037/g)).toHaveLength(1)
  })

  it.each([
    ["README.md:12", "README.md", "/repo", 12],
    ["README.md:12:3", "README.md", "/repo", 12],
    ["file:///repo/README.md:12", "/repo/README.md", "/repo", 12],
  ])("keeps authored file target %s actionable through Markdown URL handling", async (href, path, workspaceRoot, line) => {
    const openFile = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { openFile },
    })
    const user = userEvent.setup()
    render(
      <MarkdownView text={`[Readme](${href})`} workspaceRoot={workspaceRoot} />,
    )
    const link = screen.getByRole("link", { name: "Readme" })
    await user.keyboard("{Control>}")
    await user.click(link)
    await user.keyboard("{/Control}")
    expect(openFile).toHaveBeenCalledExactlyOnceWith({
      path,
      workspaceRoot,
      line,
    })
  })

  it("resolves document links from the file directory before opening a preview", async () => {
    const user = userEvent.setup()
    render(
      <MarkdownView
        text="[Parent](../README.md) and [Sibling](./usage.md)"
        workspaceRoot="/repo"
        documentPath="/repo/docs/guide.md"
      />,
    )
    await user.click(screen.getByRole("link", { name: "Parent" }))
    await user.click(screen.getByRole("link", { name: "Sibling" }))
    expect(useWorkspaceStore.getState().tabs).toEqual([
      expect.objectContaining({
        kind: "file",
        path: "README.md",
        cwd: "/repo",
      }),
      expect.objectContaining({
        kind: "file",
        path: "usage.md",
        cwd: "/repo/docs",
      }),
    ])
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
      <MarkdownView text="[click](javascript:alert(1)) and [mail](mailto:a@b.c) and [phone](tel:123)" />,
    )

    // react-markdown strips the javascript: href, so it renders without a
    // link role at all; only the mailto: anchor is clickable.
    expect(screen.getByText("phone").getAttribute("href")).toBeNull()
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

describe("CJK and math", () => {
  it.each([
    ["これは**「重要なこと」**です。", "strong", "「重要なこと」"],
    ["~~中文。~~下一句", "del", "中文。"],
  ])("renders adjacent CJK delimiters in %s", (text, tag, expected) => {
    const { container } = render(<MarkdownView text={text} />)
    expect(container.querySelector(tag)?.textContent).toBe(expected)
  })

  it("renders dollar and LaTeX math delimiters with KaTeX", () => {
    const { container } = render(
      <MarkdownView
        text={
          "Inline $E=mc^2$ and \\(x^2+y^2=z^2\\).\n\n\\[\na+b=c\n\\]\n\n$$\nx+y=z\n$$"
        }
      />,
    )
    expect(container.querySelectorAll(".katex")).toHaveLength(4)
    expect(container.querySelectorAll(".katex-display")).toHaveLength(2)
  })

  it("does not interpret math delimiters inside inline code", () => {
    const { container } = render(<MarkdownView text="Use `$x$` literally." />)
    expect(container.querySelector(".katex")).toBeNull()
    expect(container.querySelector("code")?.textContent).toBe("$x$")
  })
})

describe("raw HTML trust boundaries", () => {
  const text = '<span data-local-html="trusted">local HTML</span>'

  it("keeps model HTML as text by default", () => {
    const { container } = render(<MarkdownView text={text} />)
    expect(container.querySelector("[data-local-html]")).toBeNull()
    expect(container.textContent).toContain(text)
  })

  it("renders safe HTML when the caller trusts the document", () => {
    const { container } = render(<MarkdownView text={text} allowRawHtml />)
    expect(container.querySelector("[data-local-html]")?.textContent).toBe(
      "local HTML",
    )
  })

  it("removes scripts and event handlers from trusted document HTML", () => {
    const { container } = render(
      <MarkdownView
        text={`${text}<script>alert("no")</script><span onclick="alert('no')">safe</span>`}
        allowRawHtml
      />,
    )
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("[onclick]")).toBeNull()
    expect(container.textContent).toContain("safe")
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
