// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"

afterEach(cleanup)

it("matches a full Markdown parse while appending after a closed code fence", () => {
  const first = "Intro\n\n```ts\nconst value = 1\n```\n\nNext"
  const { container, rerender } = render(
    <MarkdownView text={first} streaming />,
  )
  rerender(<MarkdownView text={`${first} **bold**`} streaming />)
  const streamed = container.querySelector(".markdown")?.innerHTML

  const complete = render(<MarkdownView text={`${first} **bold**`} />)
  expect(streamed).toBe(
    complete.container.querySelector(".markdown")?.innerHTML,
  )
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
