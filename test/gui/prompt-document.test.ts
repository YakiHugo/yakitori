import { expect, it } from "vitest"
import {
  parsePrompt,
  promptOffset,
  promptPosition,
  serializePrompt,
} from "../../src/gui/components/prompt-document.ts"

it("roundtrips multiline text and inline path-qualified skills without moving them", () => {
  const text = "请用 [$review](/skills/review/SKILL.md) 检查\n\n然后测试 🐣"
  const doc = parsePrompt(text)
  expect(serializePrompt(doc)).toBe(text)
  expect(doc.firstChild?.child(1).type.name).toBe("skill")
  expect(doc.firstChild?.child(1).nodeSize).toBe(1)
})

it("maps caret offsets across an atomic skill and paragraph boundary", () => {
  const doc = parsePrompt("a [$x](/x) b\nc")
  expect(promptOffset(doc, 3)).toBe(2)
  expect(promptOffset(doc, 4)).toBe(10)
  expect(promptOffset(doc, 8)).toBe(13)
  expect(promptPosition(doc, 2)).toBe(3)
  expect(promptPosition(doc, 10)).toBe(4)
  expect(promptPosition(doc, 13)).toBe(8)
})

it("leaves ordinary dollar expressions and incomplete mentions as editable text", () => {
  const text = "$HOME costs $20; [$unfinished]("
  const paragraph = parsePrompt(text).firstChild
  expect(paragraph?.childCount).toBe(1)
  expect(paragraph?.firstChild?.isText).toBe(true)
  expect(paragraph?.textContent).toBe(text)
})

it("roundtrips inline file mentions and maps caret offsets across them", () => {
  const text = "看看 [@app.tsx](src/gui/app.tsx) 这页"
  const doc = parsePrompt(text)
  expect(serializePrompt(doc)).toBe(text)
  expect(doc.firstChild?.child(1).type.name).toBe("file")
  expect(doc.firstChild?.child(1).nodeSize).toBe(1)

  const caret = parsePrompt("a [@x](/x) b\nc")
  expect(promptOffset(caret, 3)).toBe(2)
  expect(promptOffset(caret, 4)).toBe(10)
  expect(promptOffset(caret, 8)).toBe(13)
  expect(promptPosition(caret, 2)).toBe(3)
  expect(promptPosition(caret, 10)).toBe(4)
  expect(promptPosition(caret, 13)).toBe(8)
})
