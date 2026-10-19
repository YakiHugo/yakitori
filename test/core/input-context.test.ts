import { expect, it } from "vitest"
import { isContextExcerpt } from "../../src/protocol/input-context.ts"
import {
  createUserInput,
  isInputContent,
} from "../../src/protocol/user-input.ts"

const excerpt = {
  id: "excerpt_1",
  text: "Captured text",
  source: {
    kind: "message",
    label: "Response",
    sessionId: "source_session",
    messageId: "answer",
  },
}

it.each([
  { comment: "Explain this" },
  { anchor: { startOffset: 0, endOffset: 13 } },
  { comment: "Explain this", anchor: { startOffset: 0, endOffset: 13 } },
  {},
])("admits excerpt comments independently of rendered source anchors: %j", (details) => {
  expect(
    isInputContent({
      ...createUserInput(""),
      references: [{ ...excerpt, ...details }],
    }),
  ).toBe(true)
})

it.each([
  { kind: "message", label: "Response", messageId: "answer" },
  { kind: "message", label: "Response", sessionId: "source" },
  { kind: "file", label: "File" },
  { kind: "browser", label: "Page" },
  {
    kind: "browser",
    label: "Page",
    url: "https://example.com",
    sessionId: "destination",
  },
])("rejects sources without their required identity or with unrelated fields: %j", (source) => {
  expect(isContextExcerpt({ ...excerpt, source })).toBe(false)
})

it.each([
  { startOffset: -1, endOffset: 5 },
  { startOffset: 3, endOffset: 2 },
  { startOffset: 0.5, endOffset: 3 },
  { startOffset: 2, endOffset: 2 },
  { startOffset: 0, endOffset: 5, path: "wrong coordinate system" },
])("rejects invalid rendered text anchors: %j", (anchor) => {
  expect(isContextExcerpt({ ...excerpt, anchor })).toBe(false)
})

it("rejects obsolete excerpt kinds instead of silently dropping their meaning", () => {
  expect(isContextExcerpt({ ...excerpt, kind: "selection" })).toBe(false)
  expect(isContextExcerpt({ ...excerpt, kind: "annotation" })).toBe(false)
})
