// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createRef, useState } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { InputDraft } from "../../src/core/user-input.ts"
import { inputContentText } from "../../src/core/user-input.ts"
import {
  PromptEditor,
  type PromptEditorHandle,
} from "../../src/gui/components/prompt-editor.tsx"
import { inputAttachmentOwnership } from "../../src/gui/input-attachment-ownership.ts"
import { textInputDraft } from "../../src/gui/input-draft.ts"
import { clearThreadScopes } from "../../src/gui/store/thread-scope-store.ts"
import {
  selectWorkspacePresentation,
  useWorkspaceStore,
} from "../../src/gui/store/workspace-store.ts"
import type {
  ImageAttachment,
  PdfAttachment,
  UserAttachment,
} from "../../src/kernel/events.ts"
import { inputFixture } from "../fixtures/user-input.ts"

beforeEach(() => {
  clearThreadScopes()
})
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

it("restores each thread's document and undo history after remounting", () => {
  const drafts: Record<string, string> = {}
  function ScopedFixture({ scopeKey }: Readonly<{ scopeKey: string }>) {
    const [, refresh] = useState(0)
    const text = drafts[scopeKey] ?? ""
    return (
      <>
        <PromptEditor
          key={scopeKey}
          scopeKey={scopeKey}
          apiBase="http://localhost"
          label="Prompt"
          value={textInputDraft(text)}
          onChange={(parts) => {
            drafts[scopeKey] = inputContentText(inputFixture(parts))
            refresh((value) => value + 1)
          }}
        />
        <output data-testid="scoped-text">{text}</output>
      </>
    )
  }
  const paste = (text: string) => {
    const editor = screen.getByRole("textbox")
    editor.focus()
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    })
  }
  const { rerender } = render(<ScopedFixture scopeKey="thread-a" />)
  paste("Alpha")
  rerender(<ScopedFixture scopeKey="thread-b" />)
  paste("Beta")
  rerender(<ScopedFixture scopeKey="thread-a" />)
  expect(screen.getByTestId("scoped-text").textContent).toBe("Alpha")
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(screen.getByTestId("scoped-text").textContent).toBe("")
  rerender(<ScopedFixture scopeKey="thread-b" />)
  expect(screen.getByTestId("scoped-text").textContent).toBe("Beta")
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
  expect(
    selectWorkspacePresentation(useWorkspaceStore.getState()),
  ).toMatchObject({ open: true })
  expect(
    useWorkspaceStore
      .getState()
      .tabs.find(
        (tab) =>
          tab.id ===
          selectWorkspacePresentation(useWorkspaceStore.getState()).activeId,
      ),
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
  onSelection,
  apiBase = "http://ordered-editor.test/",
}: {
  initial: InputDraft
  handle: React.RefObject<PromptEditorHandle | null>
  discard?: (images: readonly UserAttachment[]) => void
  onSelection?: (from: number, to: number) => void
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
        {...(onSelection ? { onSelection } : {})}
        {...(discard ? { onDiscardAttachments: discard } : {})}
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

it("appends imported images after the authored text during asynchronous import", () => {
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
  // Images bypass the document: the marker rejoins at the end of the text,
  // wherever the cursor stood while bytes loaded.
  expect(editedParts()).toEqual(
    inputFixture([
      { type: "text", text: "before after " },
      { ...stagedImage, type: "image" },
    ]),
  )
  expect(screen.getByRole("textbox").textContent).toBe("before after")
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

it("releases a removed image's staging bytes immediately, with no Undo path back", () => {
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
  expect(discard).toHaveBeenCalledExactlyOnceWith([stagedImage])
  // The removal was never a document transaction, so Undo cannot restore it.
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true })
  expect(editedParts()).toEqual(
    inputFixture([{ type: "text", text: "beforeafter" }]),
  )
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
it("keeps queued PDF imports in order before text typed at their shared caret", () => {
  const handle = createRef<PromptEditorHandle>()
  render(
    <OrderedFixture
      handle={handle}
      initial={inputFixture([{ type: "text", text: "before" }])}
    />,
  )
  const first = handle.current?.captureAttachmentInsertion()
  const second = handle.current?.captureAttachmentInsertion()
  const otherPdf = {
    ...stagedPdf,
    name: "second.pdf",
    file: { ...stagedPdf.file, path: "attachments/staging/second/manual.pdf" },
  }
  pasteText(" after")
  act(() => {
    expect(first?.insert([stagedPdf])).toBe(true)
  })
  act(() => {
    expect(second?.insert([otherPdf])).toBe(true)
  })
  expect(editedParts()).toEqual(
    inputFixture([
      { type: "text", text: "before" },
      { ...stagedPdf, type: "document" },
      { ...otherPdf, type: "document" },
      { type: "text", text: " after" },
    ]),
  )
})

it("keeps mixed queued imports ordered while retaining images outside the text document", () => {
  const handle = createRef<PromptEditorHandle>()
  render(<OrderedFixture handle={handle} initial={inputFixture([])} />)
  const first = handle.current?.captureAttachmentInsertion()
  const second = handle.current?.captureAttachmentInsertion()
  const otherPdf = {
    ...stagedPdf,
    name: "second.pdf",
    file: { ...stagedPdf.file, path: "attachments/staging/second/manual.pdf" },
  }
  const otherImage = {
    ...stagedImage,
    name: "second.png",
    file: {
      ...stagedImage.file,
      path: "attachments/staging/second/placed.png",
    },
  }
  act(() => {
    expect(first?.insert([stagedImage, stagedPdf])).toBe(true)
  })
  act(() => {
    expect(second?.insert([otherPdf, otherImage])).toBe(true)
  })
  expect(editedParts()).toEqual(
    inputFixture([
      { ...stagedPdf, type: "document" },
      { ...otherPdf, type: "document" },
      { type: "text", text: " " },
      { ...stagedImage, type: "image" },
      { ...otherImage, type: "image" },
    ]),
  )
})

it("replaces a captured selection once and places the next queued PDF after it", () => {
  const handle = createRef<PromptEditorHandle>()
  render(
    <OrderedFixture
      handle={handle}
      initial={inputFixture([{ type: "text", text: "replace me" }])}
    />,
  )
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "a", ctrlKey: true })
  const first = handle.current?.captureAttachmentInsertion()
  const second = handle.current?.captureAttachmentInsertion()
  const otherPdf = {
    ...stagedPdf,
    name: "second.pdf",
    file: { ...stagedPdf.file, path: "attachments/staging/second/manual.pdf" },
  }
  act(() => {
    expect(first?.insert([stagedPdf])).toBe(true)
  })
  act(() => {
    expect(second?.insert([otherPdf])).toBe(true)
  })
  expect(editedParts()).toEqual(
    inputFixture([
      { ...stagedPdf, type: "document" },
      { ...otherPdf, type: "document" },
    ]),
  )
})

it.each([
  {
    name: "identical",
    first: [1, 5],
    second: [1, 5],
    before: "A",
    between: "",
    after: "F",
    reversed: false,
  },
  {
    name: "overlapping",
    first: [0, 4],
    second: [2, 6],
    before: "",
    between: "",
    after: "EF",
    reversed: false,
  },
  {
    name: "adjacent on the right",
    first: [0, 3],
    second: [3, 6],
    before: "",
    between: "",
    after: "",
    reversed: false,
  },
  {
    name: "adjacent on the left",
    first: [3, 6],
    second: [0, 3],
    before: "",
    between: "",
    after: "",
    reversed: true,
  },
  {
    name: "disjoint",
    first: [0, 2],
    second: [4, 6],
    before: "",
    between: "CD",
    after: "",
    reversed: false,
  },
] as const)("preserves both queued PDFs from $name text selections", async ({
  first: firstRange,
  second: secondRange,
  before,
  between,
  after,
  reversed,
}) => {
  const handle = createRef<PromptEditorHandle>()
  const onSelection = vi.fn()
  render(
    <OrderedFixture
      handle={handle}
      onSelection={onSelection}
      initial={inputFixture([{ type: "text", text: "ABCDEF" }])}
    />,
  )
  const editor = screen.getByRole("textbox")
  // Allow the editor's initial focus normalization before changing the native
  // selection. Both captures must use real TextSelections, not Select All.
  await act(async () => {
    handle.current?.focus()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const select = async (from: number, to: number) => {
    await act(async () => {
      const text = editor.querySelector("p")?.firstChild
      if (!text) throw new Error("Expected a draft paragraph")
      window.getSelection()?.setBaseAndExtent(text, from, text, to)
      document.dispatchEvent(new Event("selectionchange"))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(onSelection).toHaveBeenLastCalledWith(from, to)
  }
  await select(firstRange[0], firstRange[1])
  const first = handle.current?.captureAttachmentInsertion()
  await select(secondRange[0], secondRange[1])
  const second = handle.current?.captureAttachmentInsertion()
  const otherPdf = {
    ...stagedPdf,
    name: "second.pdf",
    file: { ...stagedPdf.file, path: "attachments/staging/second/manual.pdf" },
  }
  act(() => {
    expect(first?.insert([stagedPdf])).toBe(true)
  })
  act(() => {
    expect(second?.insert([otherPdf])).toBe(true)
  })
  expect(editedParts()).toEqual(
    inputFixture([
      ...(before ? [{ type: "text" as const, text: before }] : []),
      { ...(reversed ? otherPdf : stagedPdf), type: "document" },
      ...(between ? [{ type: "text" as const, text: between }] : []),
      { ...(reversed ? stagedPdf : otherPdf), type: "document" },
      ...(after ? [{ type: "text" as const, text: after }] : []),
    ]),
  )
})

it("maps queued imports through edits at a different caret without following the moved cursor", () => {
  const handle = createRef<PromptEditorHandle>()
  render(
    <OrderedFixture
      handle={handle}
      initial={inputFixture([{ type: "text", text: "tail" }])}
    />,
  )
  const first = handle.current?.captureAttachmentInsertion()
  const second = handle.current?.captureAttachmentInsertion()
  act(() => handle.current?.replaceRange(0, 0, "prefix "))
  const otherPdf = {
    ...stagedPdf,
    name: "second.pdf",
    file: { ...stagedPdf.file, path: "attachments/staging/second/manual.pdf" },
  }
  act(() => {
    expect(first?.insert([stagedPdf])).toBe(true)
  })
  act(() => {
    expect(second?.insert([otherPdf])).toBe(true)
  })
  expect(editedParts()).toEqual(
    inputFixture([
      { type: "text", text: "prefix tail" },
      { ...stagedPdf, type: "document" },
      { ...otherPdf, type: "document" },
    ]),
  )
})

it("keeps PDFs inline, appends images after the text, and retains PDF Undo ownership", () => {
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
      { type: "text", text: "after " },
      { ...stagedImage, type: "image" },
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

it.each([
  false,
  true,
])("lets only unhandled native Escape reach the conversation (handled=%s)", (handled) => {
  const onKeyDown = vi.fn(() => handled)
  render(
    <PromptEditor
      apiBase="http://localhost"
      label="Prompt"
      value={textInputDraft("draft")}
      onChange={() => {}}
      onKeyDown={onKeyDown}
    />,
  )
  const editor = screen.getByRole("textbox")
  expect(fireEvent.keyDown(editor, { key: "Escape", keyCode: 27 })).toBe(
    !handled,
  )
  expect(onKeyDown).toHaveBeenCalledOnce()
  expect(editor.textContent).toBe("draft")
})
