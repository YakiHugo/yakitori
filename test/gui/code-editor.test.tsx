// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view"
import { act, cleanup, render, screen } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { CodeEditor } from "../../src/gui/components/code-editor.tsx"

afterEach(cleanup)

it("initializes a changed file path from that file's content and line separator", () => {
  const onChange = vi.fn()
  const view = render(
    <CodeEditor
      value={"first\r\n"}
      path="first.txt"
      wrap
      onChange={onChange}
      onSave={() => {}}
    />,
  )
  view.rerender(
    <CodeEditor
      value={"second\n"}
      path="second.txt"
      wrap
      onChange={onChange}
      onSave={() => {}}
    />,
  )
  const editor = EditorView.findFromDOM(
    screen.getByRole("textbox", { name: "Edit second.txt" }),
  )
  expect(editor?.state.sliceDoc()).toBe("second\n")
  expect(editor?.state.doc.lines).toBe(2)
  expect(onChange).not.toHaveBeenCalled()
})

it("applies an external document without reporting another user edit", () => {
  const onChange = vi.fn()
  const view = render(
    <CodeEditor
      value="64"
      path="config.toml"
      wrap
      onChange={onChange}
      onSave={() => {}}
    />,
  )
  view.rerender(
    <CodeEditor
      value="640"
      path="config.toml"
      wrap
      onChange={onChange}
      onSave={() => {}}
    />,
  )
  const editor = EditorView.findFromDOM(
    screen.getByRole("textbox", { name: "Edit config.toml" }),
  )
  expect(editor?.state.sliceDoc()).toBe("640")
  expect(onChange).not.toHaveBeenCalled()
})

it("preserves newer typing between a React commit and passive effects", () => {
  const onChange = vi.fn()
  function Owner({ value, type }: { value: string; type: boolean }) {
    useLayoutEffect(() => {
      if (!type) return
      const editor = EditorView.findFromDOM(
        screen.getByRole("textbox", { name: "Edit config.toml" }),
      )
      if (!editor) throw new Error("Missing real editor")
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: "64000" },
        userEvent: "input.type",
      })
    }, [type])
    return (
      <CodeEditor
        value={value}
        path="config.toml"
        wrap
        onChange={onChange}
        onSave={() => {}}
      />
    )
  }
  const view = render(<Owner value="64" type={false} />)
  view.rerender(<Owner value="640" type />)
  const editor = EditorView.findFromDOM(
    screen.getByRole("textbox", { name: "Edit config.toml" }),
  )
  expect(editor?.state.sliceDoc()).toBe("64000")
  expect(onChange.mock.calls).toEqual([["64000"]])
})

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
