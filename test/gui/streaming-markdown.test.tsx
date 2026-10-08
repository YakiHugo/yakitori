// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"

afterEach(cleanup)

it("parses appended bold text after a cached code fence without changing earlier blocks", () => {
  const first = "Intro\n\n```ts\nconst value = 1\n```\n\nNext"
  const { container, rerender } = render(
    <MarkdownView text={first} streaming />,
  )
  rerender(<MarkdownView text={`${first} **bold**`} streaming />)
  expect(container.querySelector("strong")?.textContent).toBe("bold")
  expect(container.querySelectorAll("pre code")).toHaveLength(1)
  expect(container.querySelector("pre code")?.textContent).toBe(
    "const value = 1\n",
  )
  expect(
    Array.from(container.querySelectorAll("p"), (node) => node.textContent),
  ).toEqual(["Intro", "Next bold"])
})

it("resolves a definition added after a cached fenced block", () => {
  const first = "```text\ncode\n```\n\n[read][target]"
  const { container, rerender } = render(
    <MarkdownView text={first} streaming />,
  )
  rerender(
    <MarkdownView
      text={`${first}\n\n[target]: https://example.com/reference`}
      streaming
    />,
  )
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com/reference",
  )
})

it.each([
  "\n\n- [x] done\n- [ ] later\n\n| Key | Value |\n| --- | --- |\n| A | **B** |",
  "\n\n> quote\n>\n> second\n\n~~~text\nnext\n~~~\n\nTail",
  "\n\n[linked][target]\n\n[target]: https://example.com/reference",
  "\n\nFootnote[^a].\n\n[^a]: A **note**",
  "\r\n\r\nChanged line endings\r\n",
])("renders appended Markdown identically to a completed parse: %j", (suffix) => {
  const prefix = "Intro\n\n```text\nliteral <&>\n```\n\nTail"
  const live = render(<MarkdownView text={prefix} streaming />)
  live.rerender(<MarkdownView text={prefix + suffix} streaming />)
  const completed = render(<MarkdownView text={prefix + suffix} />)
  // Code copy controls are part of the real renderer on both paths.
  expect(live.container.innerHTML).toBe(completed.container.innerHTML)
})

it("drops a cached prefix when a streaming response is replaced or finalized", () => {
  const prefix = "Old\n\n```text\nold code\n```\n\nTail"
  const { container, rerender } = render(
    <MarkdownView text={prefix} streaming />,
  )
  const replacement = "New\n\n```text\nnew code\n```\n\n**done**"
  rerender(<MarkdownView text={replacement} streaming />)
  expect(container.textContent).not.toContain("old")
  expect(container.querySelector("strong")?.textContent).toBe("done")
  rerender(<MarkdownView text={replacement} />)
  expect(container.textContent).not.toContain("old")
  expect(container.querySelectorAll("pre")).toHaveLength(1)
})
