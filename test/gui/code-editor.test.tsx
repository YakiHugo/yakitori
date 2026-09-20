// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { CodeEditor } from "../../src/gui/components/code-editor.tsx"

afterEach(cleanup)

it.each([
  { source: "\ufefffirst\r\n", expected: "\ufefffirst\r\nsecond\r\nthird\r\n" },
  { source: "first\r", expected: "first\rsecond\rthird\r" },
  { source: "first\n", expected: "first\nsecond\nthird\n" },
])("keeps file line endings and real editor lines when pasting into $source", ({
  source,
  expected,
}) => {
  const onChange = vi.fn()
  render(
    <CodeEditor
      value={source}
      path="notes.txt"
      wrap={false}
      onChange={onChange}
      onSave={() => {}}
    />,
  )
  const content = screen.getByRole("textbox", { name: "Edit notes.txt" })
  const editor = EditorView.findFromDOM(content)
  if (!editor) throw new Error("Expected an attached CodeMirror editor.")
  act(() => {
    editor.dispatch({ selection: { anchor: editor.state.doc.length } })
    const clipboard = new DataTransfer()
    clipboard.setData("text/plain", "second\nthird\n")
    content.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    )
  })
  expect(onChange).toHaveBeenLastCalledWith(expected)
  expect(editor.state.doc.lines).toBe(4)
  expect(editor.state.doc.line(2).text).toBe("second")
  expect(editor.state.doc.line(3).text).toBe("third")
})
