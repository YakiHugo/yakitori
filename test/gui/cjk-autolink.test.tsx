// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"

afterEach(cleanup)

it.each([
  ["链接 https://example.com/a。", "https://example.com/a"],
  ["见 https://example.com/a?b=1，谢谢", "https://example.com/a?b=1"],
  ["（见 https://example.com/a）", "https://example.com/a"],
  [
    "PR：https://github.com/blueberrycongee/wuu/pull/45（分支 → main…）",
    "https://github.com/blueberrycongee/wuu/pull/45",
  ],
  ["https://example.com/a, next", "https://example.com/a"],
])("keeps CJK prose out of a bare autolink: %s", (text, href) => {
  const { container } = render(<MarkdownView text={text} />)
  const link = container.querySelector("a")
  expect(link?.getAttribute("href")).toBe(href)
  expect(container.textContent).not.toContain("**")
})

it("keeps paired fullwidth parentheses in a bare autolink", () => {
  const href = "https://example.com/a（注释）"
  const { container } = render(<MarkdownView text={href} />)
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    new URL(href).href,
  )
})

it("does not trim an explicit Markdown link", () => {
  const { container } = render(
    <MarkdownView text="[文档](https://example.com/a。)" />,
  )
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    new URL("https://example.com/a。").href,
  )
})

it("keeps a bold label and an adjacent bare URL as siblings", () => {
  const { container } = render(
    <MarkdownView text="**入口:**http://localhost:5174/**" />,
  )
  expect(container.querySelector("strong")?.textContent).toBe("入口:")
  const link = container.querySelector("a")
  expect(link?.getAttribute("href")).toBe("http://localhost:5174/")
  expect(link?.closest("strong")).toBeNull()
  expect(container.textContent).toBe("入口:http://localhost:5174/")
})

it("trims an autolink after more CJK prose streams in", () => {
  const prefix = "Intro\n\n```text\ncode\n```\n\n见 https://example.com/a?b=1"
  const { container, rerender } = render(
    <MarkdownView text={prefix} streaming />,
  )
  rerender(<MarkdownView text={`${prefix}，谢谢`} streaming />)
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com/a?b=1",
  )
  expect(container.textContent).toContain("，谢谢")
})
