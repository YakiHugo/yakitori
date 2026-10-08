// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { markdownVisibleText } from "../../src/core/thread-search.ts"
import { conversationFindRanges } from "../../src/gui/components/conversation-find-text.ts"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"

afterEach(cleanup)

it.each([
  [
    "body[^x]\n\n[^x]: first visible definition\n\n[^x]: second invisible definition",
    "first visible definition",
  ],
  [
    "body[^x]\n\n> [^x]: nested visible definition",
    "nested visible definition",
  ],
  [
    "body[^x]\n\n- [^x]: nested list visible definition",
    "nested list visible definition",
  ],
])("indexes the rendered first footnote definition for %s", (markdown, visible) => {
  const { container } = render(<MarkdownView text={markdown} />)
  expect(conversationFindRanges(container, visible)).toHaveLength(1)
  expect(markdownVisibleText(markdown)).toContain(visible)
  expect(markdownVisibleText(markdown)).not.toContain(
    "second invisible definition",
  )
})

it.each([
  ["call open_file now", "call open_file now"],
  ["see src/foo_bar.ts", "see src/foo_bar.ts"],
  ["left | right", "left | right"],
  ["`foo_bar | **literal** &amp;`", "foo_bar | **literal** &amp;"],
  ["```ts\nfoo_bar | **literal** &amp;\n```", "foo_bar | **literal** &amp;"],
  ["use \\_literal\\_ and \\*stars\\*", "use _literal_ and *stars*"],
  ["<span>raw &amp; HTML</span>", "<span>raw & HTML</span>"],
  ["<div>raw &amp; HTML</div>", "<div>raw &amp; HTML</div>"],
  ["<div>one</div>\n\n<div>two</div>", "<div>one</div> <div>two</div>"],
  ["&copy; &eacute; &#x1F600;", "© é 😀"],
  ["[foo_bar | label](https://example.com)", "foo_bar | label"],
  [
    "| First | Second |\n| --- | --- |\n| foo_bar | x\\|y |",
    "First Second foo_bar x|y",
  ],
  [
    "# Heading\n\n**bold** and _emphasis_\n\n- first\n- second",
    "Heading bold and emphasis first second",
  ],
])("indexes the actual rendered Markdown text for %s", (markdown, visible) => {
  const { container } = render(<MarkdownView text={markdown} />)
  expect(conversationFindRanges(container, visible)).toHaveLength(1)
  expect(markdownVisibleText(markdown)).toBe(visible)
})
