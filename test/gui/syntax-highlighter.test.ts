import { expect, it } from "vitest"
import { languageForPath } from "../../src/gui/lib/syntax-highlighter.ts"

it.each([
  ["src/component.TSX", "tsx"],
  ["types/example.d.ts", "typescript"],
  ["C:\\repo\\index.mjs", "javascript"],
  ["Dockerfile", "dockerfile"],
  ["Dockerfile.test", "dockerfile"],
  ["Makefile", "makefile"],
  [".zshrc", "shellscript"],
  ["README.md", "markdown"],
  ["image.svg", "xml"],
  ["README", undefined],
  ["file.unknown", undefined],
  ["file.__proto__", undefined],
])("infers %s as %s", (path, expected) => {
  expect(languageForPath(path)).toBe(expected)
})
