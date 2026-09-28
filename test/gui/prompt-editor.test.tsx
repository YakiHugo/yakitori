// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { PromptEditor } from "../../src/gui/components/prompt-editor.tsx"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"

afterEach(cleanup)

function Fixture() {
  const [text, setText] = useState("Replace this draft")
  return (
    <>
      <PromptEditor label="Prompt" value={text} onChange={setText} />
      <output data-testid="serialized">{text}</output>
    </>
  )
}

it("replaces selected content with plain text from a rich clipboard and preserves line breaks", () => {
  render(<Fixture />)
  const editor = screen.getByRole("textbox")
  editor.focus()
  fireEvent.keyDown(editor, { key: "a", ctrlKey: true })
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) =>
        type === "text/html"
          ? "<p><strong>Copied text</strong></p><p>Second line</p>"
          : type === "text/plain"
            ? "Copied text\r\nSecond line"
            : "",
    },
  })
  expect(screen.getByTestId("serialized").textContent).toBe(
    "Copied text\nSecond line",
  )
})

it("roundtrips copied inline skills through the editor's rich clipboard", () => {
  render(<Fixture />)
  const editor = screen.getByRole("textbox")
  editor.focus()
  fireEvent.keyDown(editor, { key: "a", ctrlKey: true })
  const text = "Use [$review](/skills/review/SKILL.md) here"
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  })
  fireEvent.keyDown(editor, { key: "a", ctrlKey: true })
  const clipboard = new Map<string, string>()
  fireEvent.copy(editor, {
    clipboardData: {
      clearData: () => clipboard.clear(),
      setData: (type: string, value: string) => clipboard.set(type, value),
    },
  })
  expect(clipboard.get("text/plain")).toBe(text)
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => clipboard.get(type) ?? "",
    },
  })
  expect(screen.getByTestId("serialized").textContent).toBe(text)
})

it("preserves a file context mention when copying and pasting the prompt", () => {
  render(<Fixture />)
  const editor = screen.getByRole("textbox")
  editor.focus()
  fireEvent.keyDown(editor, { key: "a", ctrlKey: true })
  const text = "Check [@composer.tsx](src/gui/composer.tsx) here"
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  })
  fireEvent.keyDown(editor, { key: "a", ctrlKey: true })
  const clipboard = new Map<string, string>()
  fireEvent.copy(editor, {
    clipboardData: {
      clearData: () => clipboard.clear(),
      setData: (type: string, value: string) => clipboard.set(type, value),
    },
  })
  expect(clipboard.get("text/plain")).toBe(text)
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => clipboard.get(type) ?? "",
    },
  })
  expect(screen.getByTestId("serialized").textContent).toBe(text)
})

function ExternalFixture() {
  const [text, setText] = useState("Replace this draft")
  return (
    <>
      <PromptEditor label="Prompt" value={text} onChange={setText} />
      <output data-testid="serialized">{text}</output>
      <button type="button" onClick={() => setText("Restored draft")}>
        restore
      </button>
    </>
  )
}

it("resets the document and undo history when the value changes externally", () => {
  render(<ExternalFixture />)
  const editor = screen.getByRole("textbox")
  editor.focus()
  fireEvent.keyDown(editor, { key: "a", ctrlKey: true })
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? "Typed draft" : ""),
    },
  })
  expect(screen.getByTestId("serialized").textContent).toBe("Typed draft")
  fireEvent.click(screen.getByRole("button", { name: "restore" }))
  expect(screen.getByTestId("serialized").textContent).toBe("Restored draft")
  expect(editor.textContent).toBe("Restored draft")
  fireEvent.keyDown(editor, { key: "z", ctrlKey: true })
  expect(screen.getByTestId("serialized").textContent).toBe("Restored draft")
  expect(editor.textContent).toBe("Restored draft")
})

it("does not delegate Enter to onKeyDown during IME composition", () => {
  const onKeyDown = vi.fn(() => false)
  render(
    <PromptEditor
      label="Prompt"
      value="Draft"
      onChange={() => {}}
      onKeyDown={onKeyDown}
    />,
  )
  const editor = screen.getByRole("textbox")
  editor.focus()
  fireEvent.keyDown(editor, { key: "Enter", isComposing: true })
  expect(onKeyDown).not.toHaveBeenCalled()
  fireEvent.compositionStart(editor)
  fireEvent.keyDown(editor, { key: "Enter" })
  fireEvent.compositionEnd(editor)
  expect(onKeyDown).not.toHaveBeenCalled()
  fireEvent.keyDown(editor, { key: "Enter" })
  expect(onKeyDown).toHaveBeenCalledTimes(1)
})

it("blocks editing while disabled", () => {
  const onChange = vi.fn()
  render(
    <PromptEditor
      label="Prompt"
      value="Locked draft"
      onChange={onChange}
      disabled
    />,
  )
  const editor = screen.getByRole("textbox")
  editor.focus()
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? "Pasted text" : ""),
    },
  })
  expect(onChange).not.toHaveBeenCalled()
  expect(editor.textContent).toBe("Locked draft")
})

function SkillFixture() {
  const [text, setText] = useState("Use [$review](/skills/review/SKILL.md)")
  return (
    <>
      <PromptEditor label="Prompt" value={text} onChange={setText} />
      <output data-testid="serialized">{text}</output>
    </>
  )
}

it("deletes an inline skill atom with a single Backspace", () => {
  render(<SkillFixture />)
  const editor = screen.getByRole("textbox")
  editor.focus()
  fireEvent.keyDown(editor, { key: "Backspace" })
  expect(screen.getByTestId("serialized").textContent).toBe("Use ")
})

it("opens a skill chip in the workspace without changing the prompt", () => {
  useWorkspaceStore.getState().setSession("session_chip")
  render(<SkillFixture />)
  const chip = screen.getByRole("button", { name: "review" })
  expect(chip.textContent).toBe("review")
  fireEvent.click(chip)
  expect(useWorkspaceStore.getState()).toMatchObject({ open: true })
  expect(
    useWorkspaceStore
      .getState()
      .tabs.find((tab) => tab.id === useWorkspaceStore.getState().activeId),
  ).toMatchObject({
    kind: "skill",
    name: "review",
    path: "/skills/review/SKILL.md",
    workspaceSessionId: "session_chip",
  })
  expect(screen.getByTestId("serialized").textContent).toBe(
    "Use [$review](/skills/review/SKILL.md)",
  )
})
