// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createRef, useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { InputDraft } from "../../src/core/user-input.ts"
import { inputContentText } from "../../src/core/user-input.ts"
import {
  PromptEditor,
  type PromptEditorHandle,
} from "../../src/gui/components/prompt-editor.tsx"
import { inputAttachmentOwnership } from "../../src/gui/input-attachment-ownership.ts"
import { textInputDraft } from "../../src/gui/input-draft.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"
import type {
  ImageAttachment,
  PdfAttachment,
  UserAttachment,
} from "../../src/kernel/events.ts"
import { inputFixture } from "../fixtures/user-input.ts"

afterEach(cleanup)

function Fixture() {
  const [text, setText] = useState("Replace this draft")
  return (
    <>
      <PromptEditor
        apiBase="http://localhost"
        label="Prompt"
        value={textInputDraft(text)}
        onChange={(parts) => setText(inputContentText(inputFixture(parts)))}
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
        value={textInputDraft(text)}
        onChange={(parts) => setText(inputContentText(inputFixture(parts)))}
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
      value={textInputDraft("Draft")}
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
      value={textInputDraft("Locked draft")}
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
        value={textInputDraft(text)}
        onChange={(parts) => setText(inputContentText(inputFixture(parts)))}
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
  initial: InputDraft
  handle: React.RefObject<PromptEditorHandle | null>
  discard?: (images: readonly UserAttachment[]) => void
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
        {...(discard ? { onDiscardAttachments: discard } : {})}
        {...(preview ? { onPreviewImage: preview } : {})}
      />
      <output data-testid="parts">{JSON.stringify(parts)}</output>
      <button type="button" onClick={() => setParts(inputFixture([]))}>
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
      initial={inputFixture([{ type: "text", text: "before" }])}
    />,
  )
  const insertion = handle.current?.captureAttachmentInsertion()
  pasteText(" after")
  act(() => {
    expect(insertion?.insert([stagedImage])).toBe(true)
  })
  expect(editedParts()).toEqual(
    inputFixture([
      { type: "text", text: "before" },
      { ...stagedImage, type: "image" },
      { type: "text", text: " after" },
    ]),
  )
  expect(
    screen.getByRole("button", { name: "Preview attached image placed.png" }),
  ).toBeTruthy()
})

it("invalidates pending image insertion when the draft is externally replaced", () => {
  const handle = createRef<PromptEditorHandle>()
  render(
    <OrderedFixture
      handle={handle}
      initial={inputFixture([{ type: "text", text: "old" }])}
    />,
  )
  const insertion = handle.current?.captureAttachmentInsertion()
  fireEvent.click(screen.getByRole("button", { name: "clear ordered draft" }))
  act(() => {
    expect(insertion?.insert([stagedImage])).toBe(false)
  })
  expect(editedParts()).toEqual(inputFixture([]))
})

it("retains removed image bytes for Undo and releases only unused staging assets when history resets", () => {
  const handle = createRef<PromptEditorHandle>()
  const discard = vi.fn()
  render(
    <OrderedFixture
      handle={handle}
      discard={discard}
      initial={inputFixture([
        { type: "text", text: "before" },
        { ...stagedImage, type: "image" },
        { type: "text", text: "after" },
      ])}
    />,
  )
  act(() => handle.current?.removeAttachment(0))
  expect(editedParts()).toEqual(
    inputFixture([{ type: "text", text: "beforeafter" }]),
  )
  expect(discard).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(editedParts()).toEqual(
    inputFixture([
      { type: "text", text: "before" },
      { ...stagedImage, type: "image" },
      { type: "text", text: "after" },
    ]),
  )
  act(() => handle.current?.removeAttachment(0))
  fireEvent.click(screen.getByRole("button", { name: "clear ordered draft" }))
  expect(discard).toHaveBeenCalledExactlyOnceWith([stagedImage])
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(editedParts()).toEqual(inputFixture([]))
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
      initial={inputFixture(original)}
      preview={preview}
    />,
  )
  act(() => handle.current?.removeAttachment(0))
  inputAttachmentOwnership.promote(
    apiBase,
    inputFixture(original),
    inputFixture(accepted),
  )
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(editedParts()).toEqual(inputFixture(accepted))
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
  expect(editedParts()).toEqual(inputFixture([]))
})

const stagedPdf: PdfAttachment = {
  name: "manual.pdf",
  mediaType: "application/pdf",
  sizeBytes: 500,
  file: {
    rolloutId: "rollout_editor",
    path: "attachments/staging/pdf/manual.pdf",
  },
}
it("preserves mixed PDF/image placement, image detail indexing and PDF Undo ownership", () => {
  const handle = createRef<PromptEditorHandle>()
  const discard = vi.fn()
  render(
    <OrderedFixture
      handle={handle}
      discard={discard}
      initial={inputFixture([{ type: "text", text: "before" }])}
    />,
  )
  const insertion = handle.current?.captureAttachmentInsertion()
  pasteText("after")
  act(() => {
    expect(insertion?.insert([stagedPdf, stagedImage])).toBe(true)
  })
  expect(editedParts()).toEqual(
    inputFixture([
      { type: "text", text: "before" },
      { ...stagedPdf, type: "document" },
      { ...stagedImage, type: "image" },
      { type: "text", text: "after" },
    ]),
  )
  act(() => handle.current?.setImageDetail(1, "high"))
  expect(editedParts()).toEqual(
    inputFixture([
      { type: "text", text: "before" },
      { ...stagedPdf, type: "document" },
      { ...stagedImage, type: "image", detail: "high" },
      { type: "text", text: "after" },
    ]),
  )
  act(() => handle.current?.removeAttachment(0))
  expect(
    screen.queryByRole("button", { name: "Open attached PDF manual.pdf" }),
  ).toBeNull()
  expect(discard).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(
    screen.getByRole("button", { name: "Open attached PDF manual.pdf" }),
  ).toBeTruthy()
  act(() => handle.current?.removeAttachment(0))
  fireEvent.click(screen.getByRole("button", { name: "clear ordered draft" }))
  expect(discard.mock.calls.flat(2)).toContainEqual(stagedPdf)
})
it("resolves promoted PDF atoms for both mouse and keyboard activation", () => {
  const open = vi.fn()
  const apiBase = "http://pdf-editor.test/"
  const accepted = {
    ...stagedPdf,
    file: {
      rolloutId: "rollout_editor",
      path: "attachments/requests/pdf/manual.pdf",
    },
  }
  inputAttachmentOwnership.promote(
    apiBase,
    inputFixture([{ ...stagedPdf, type: "document" }]),
    inputFixture([{ ...accepted, type: "document" }]),
  )
  render(
    <PromptEditor
      label="PDF prompt"
      value={inputFixture([{ ...stagedPdf, type: "document" }])}
      apiBase={apiBase}
      onChange={() => {}}
      onOpenDocument={open}
    />,
  )
  const chip = screen.getByRole("button", {
    name: "Open attached PDF manual.pdf",
  })
  fireEvent.click(chip)
  fireEvent.keyDown(chip, { key: "Enter" })
  expect(open).toHaveBeenCalledTimes(2)
  expect(open).toHaveBeenLastCalledWith({ ...accepted, type: "document" })
})
it("passes every dropped file in order so unsupported content is reported rather than silently lost", () => {
  const paste = vi.fn()
  render(
    <PromptEditor
      label="PDF prompt"
      value={inputFixture([])}
      apiBase="http://localhost"
      onChange={() => {}}
      onPasteAttachments={paste}
    />,
  )
  const files = [
    new File(["pdf"], "a.pdf", { type: "application/pdf" }),
    new File(["png"], "b.png", { type: "image/png" }),
    new File(["exe"], "c.exe", { type: "application/octet-stream" }),
  ]
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { files, getData: () => "" },
  })
  expect(paste).toHaveBeenCalledExactlyOnceWith(files)
})
