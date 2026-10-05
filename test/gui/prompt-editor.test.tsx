import type { ImageAttachment, InputPart } from "../../src/kernel/events.ts"
import { inputImageOwnership } from "../../src/gui/input-image-ownership.ts"
import { textInputParts } from "../../src/gui/input-parts.ts"
import { inputContentText } from "../../src/kernel/input-content.ts"
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createRef, useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import {
  PromptEditor,
  type PromptEditorHandle,
} from "../../src/gui/components/prompt-editor.tsx"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"

afterEach(cleanup)

function Fixture() {
  const [text, setText] = useState("Replace this draft")
  return (
    <>
      <PromptEditor
        apiBase="http://localhost"
        label="Prompt"
        value={textInputParts(text)}
        onChange={(parts) =>
          setText(inputContentText({ kind: "parts", parts }))
        }
      />
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
      <PromptEditor
        apiBase="http://localhost"
        label="Prompt"
        value={textInputParts(text)}
        onChange={(parts) =>
          setText(inputContentText({ kind: "parts", parts }))
        }
      />
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
      apiBase="http://localhost"
      label="Prompt"
      value={textInputParts("Draft")}
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
      apiBase="http://localhost"
      label="Prompt"
      value={textInputParts("Locked draft")}
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
      <PromptEditor
        apiBase="http://localhost"
        label="Prompt"
        value={textInputParts(text)}
        onChange={(parts) =>
          setText(inputContentText({ kind: "parts", parts }))
        }
      />
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

const stagedImage: ImageAttachment = {
  name: "placed.png",
  mediaType: "image/png",
  sizeBytes: 10,
  detail: "original",
  file: {
    rolloutId: "rollout_editor",
    path: "attachments/staging/draft_editor/placed.png",
  },
}
function OrderedFixture({
  initial,
  handle,
  discard,
  preview,
  apiBase = "http://ordered-editor.test/",
}: {
  initial: readonly InputPart[]
  handle: React.RefObject<PromptEditorHandle | null>
  discard?: (images: readonly ImageAttachment[]) => void
  preview?: (image: ImageAttachment) => void
  apiBase?: string
}) {
  const [parts, setParts] = useState(initial)
  return (
    <>
      <PromptEditor
        ref={handle}
        label="Ordered prompt"
        apiBase={apiBase}
        value={parts}
        onChange={setParts}
        {...(discard ? { onDiscardImages: discard } : {})}
        {...(preview ? { onPreviewImage: preview } : {})}
      />
      <output data-testid="parts">{JSON.stringify(parts)}</output>
      <button type="button" onClick={() => setParts([])}>
        clear ordered draft
      </button>
    </>
  )
}
function editedParts(): unknown {
  return JSON.parse(screen.getByTestId("parts").textContent ?? "null")
}
function pasteText(text: string) {
  fireEvent.paste(screen.getByRole("textbox", { name: "Ordered prompt" }), {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  })
}

it("inserts images between authored text and preserves mapped placement during asynchronous import", () => {
  const handle = createRef<PromptEditorHandle>()
  render(
    <OrderedFixture
      handle={handle}
      initial={[{ type: "text", text: "before" }]}
    />,
  )
  const insertion = handle.current?.captureImageInsertion()
  pasteText(" after")
  act(() => {
    expect(insertion?.insert([stagedImage])).toBe(true)
  })
  expect(editedParts()).toEqual([
    { type: "text", text: "before" },
    { ...stagedImage, type: "image" },
    { type: "text", text: " after" },
  ])
  expect(
    screen.getByRole("button", { name: "Preview attached image placed.png" }),
  ).toBeTruthy()
})

it("invalidates pending image insertion when the draft is externally replaced", () => {
  const handle = createRef<PromptEditorHandle>()
  render(
    <OrderedFixture
      handle={handle}
      initial={[{ type: "text", text: "old" }]}
    />,
  )
  const insertion = handle.current?.captureImageInsertion()
  fireEvent.click(screen.getByRole("button", { name: "clear ordered draft" }))
  act(() => {
    expect(insertion?.insert([stagedImage])).toBe(false)
  })
  expect(editedParts()).toEqual([])
})

it("retains removed image bytes for Undo and releases only unused staging assets when history resets", () => {
  const handle = createRef<PromptEditorHandle>()
  const discard = vi.fn()
  render(
    <OrderedFixture
      handle={handle}
      discard={discard}
      initial={[
        { type: "text", text: "before" },
        { ...stagedImage, type: "image" },
        { type: "text", text: "after" },
      ]}
    />,
  )
  act(() => handle.current?.removeImage(0))
  expect(editedParts()).toEqual([{ type: "text", text: "beforeafter" }])
  expect(discard).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(editedParts()).toEqual([
    { type: "text", text: "before" },
    { ...stagedImage, type: "image" },
    { type: "text", text: "after" },
  ])
  act(() => handle.current?.removeImage(0))
  fireEvent.click(screen.getByRole("button", { name: "clear ordered draft" }))
  expect(discard).toHaveBeenCalledExactlyOnceWith([stagedImage])
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(editedParts()).toEqual([])
})

it("resolves image atoms restored by Undo after their staging bytes were promoted", () => {
  const apiBase = "http://promoted-editor.test/"
  const preview = vi.fn()
  const handle = createRef<PromptEditorHandle>()
  const original = [{ ...stagedImage, type: "image" as const }]
  const accepted = [
    {
      ...stagedImage,
      type: "image" as const,
      file: {
        rolloutId: "rollout_editor",
        path: "attachments/requests/accepted/placed.png",
      },
    },
  ]
  render(
    <OrderedFixture
      handle={handle}
      apiBase={apiBase}
      initial={original}
      preview={preview}
    />,
  )
  act(() => handle.current?.removeImage(0))
  inputImageOwnership.promote(
    apiBase,
    { kind: "parts", parts: original },
    { kind: "parts", parts: accepted },
  )
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(editedParts()).toEqual(accepted)
  const image = screen.getByRole("button", {
    name: "Preview attached image placed.png",
  })
  fireEvent.click(image)
  expect(preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ file: accepted[0]?.file }),
  )
  fireEvent.keyDown(image, { key: "Enter" })
  expect(preview).toHaveBeenCalledTimes(2)
  expect(preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ file: accepted[0]?.file }),
  )
  fireEvent.keyDown(screen.getByRole("textbox"), {
    key: "z",
    ctrlKey: true,
    shiftKey: true,
  })
  expect(editedParts()).toEqual([])
})
