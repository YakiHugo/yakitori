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
