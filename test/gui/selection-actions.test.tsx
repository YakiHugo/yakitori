// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  resolveAnnotationRange,
  selectionOffsets,
} from "../../src/gui/components/annotation-layer.tsx"
import {
  AnnotationLayer,
  ContextExcerptChips,
  requestAnnotationEdit,
  SelectionActions,
} from "../../src/gui/components/selection-actions.tsx"
import {
  contextSourceAttributes,
  type ResponseAnnotation,
} from "../../src/gui/conversation-context.ts"

const source = {
  kind: "message",
  label: "Assistant message",
  sessionId: "main",
  messageId: "answer",
} as const
const annotation: ResponseAnnotation = {
  id: "annotation_one",
  kind: "annotation",
  text: "useful explanation",
  source,
  anchor: { startOffset: 2, endOffset: 20 },
}

beforeEach(() => {
  const rect = new DOMRect(100, 100, 120, 20)
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(rect)
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
    Object.assign([rect], {
      item: (index: number) => (index === 0 ? rect : null),
    }),
  )
})
afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})

function selectText(element: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(element)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  fireEvent.pointerUp(element)
}

const defaultProps = () => ({
  annotations: [],
  onAddToConversation: vi.fn(),
  onUpdateAnnotation: vi.fn(),
  onRemoveAnnotation: vi.fn(),
  onAskInSideChat: vi.fn(),
})

it("shows annotation and side chat actions above the selection and creates an annotation with source offsets", async () => {
  const props = defaultProps()
  const user = userEvent.setup()
  render(
    <>
      <p {...contextSourceAttributes(source)}>
        A{" "}
        <span>
          useful <strong>explanation</strong>
        </span>
        .
      </p>
      <SelectionActions {...props} />
    </>,
  )
  const selected = screen.getByText("useful", { exact: false }).closest("span")
  if (!selected) throw new Error("Missing selected source")
  selectText(selected)
  const toolbar = screen.getByRole("toolbar")
  expect(
    within(toolbar)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Add to conversation", "Ask in side chat"])
  expect(toolbar.style.top).toBe("54px")
  await user.click(
    within(toolbar).getByRole("button", { name: "Add to conversation" }),
  )
  expect(props.onAddToConversation).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "annotation",
      text: "useful explanation",
      source,
      anchor: { startOffset: 2, endOffset: 20 },
    }),
  )
  expect(props.onAskInSideChat).not.toHaveBeenCalled()
  expect(screen.queryByRole("toolbar")).toBeNull()
})

it("carries a file selection to side chat without adding an annotation", async () => {
  const props = defaultProps()
  const user = userEvent.setup()
  const file = {
    kind: "file",
    label: "main.ts",
    path: "/repo/main.ts",
  } as const
  render(
    <>
      <pre {...contextSourceAttributes(file)}>const answer = 42</pre>
      <SelectionActions {...props} />
    </>,
  )
  selectText(screen.getByText("const answer = 42"))
  await user.click(screen.getByRole("button", { name: "Ask in side chat" }))
  expect(props.onAskInSideChat).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "selection",
      text: "const answer = 42",
      source: file,
    }),
  )
  expect(props.onAddToConversation).not.toHaveBeenCalled()
})

it("ignores editable text and selections spanning sources; Escape dismisses the toolbar", () => {
  render(
    <>
      <div {...contextSourceAttributes(source)}>
        <div contentEditable suppressContentEditableWarning>
          Draft text
        </div>
        <p>First message</p>
      </div>
      <p {...contextSourceAttributes({ ...source, messageId: "other" })}>
        Second message
      </p>
      <SelectionActions {...defaultProps()} />
    </>,
  )
  selectText(screen.getByText("Draft text"))
  expect(screen.queryByRole("toolbar")).toBeNull()
  const range = document.createRange()
  range.setStart(screen.getByText("First message"), 0)
  range.setEnd(screen.getByText("Second message"), 1)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  fireEvent.pointerUp(screen.getByText("Second message"))
  expect(screen.queryByRole("toolbar")).toBeNull()
  selectText(screen.getByText("First message"))
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("toolbar")).toBeNull()
})

it("resolves offsets across replacement text nodes and refuses a changed quote at those offsets", () => {
  const element = document.createElement("p")
  element.innerHTML = "A <span>useful <strong>explanation</strong></span>."
  const selected = element.querySelector("span")
  if (!selected) throw new Error("Missing selected source")
  const range = document.createRange()
  range.selectNodeContents(selected)
  expect(selectionOffsets(element, range)).toEqual({
    startOffset: 2,
    endOffset: 20,
  })
  element.innerHTML = "<span>A useful</span><em> explanation.</em>"
  expect(resolveAnnotationRange(element, annotation)?.toString()).toBe(
    "useful explanation",
  )
  element.textContent = "A changed explanation."
  expect(resolveAnnotationRange(element, annotation)).toBeUndefined()
})

function Draft() {
  const [annotations, setAnnotations] = useState<ResponseAnnotation[]>([])
  const update = (next: ResponseAnnotation) =>
    setAnnotations((items) =>
      items.map((item) => (item.id === next.id ? next : item)),
    )
  const remove = (id: string) =>
    setAnnotations((items) => items.filter((item) => item.id !== id))
  return (
    <>
      <p {...contextSourceAttributes(source)}>
        A <span>useful explanation</span>.
      </p>
      <div data-composer-surface="">
        <button type="button">Main composer</button>
      </div>
      <ContextExcerptChips
        excerpts={annotations}
        onChange={update}
        onRemove={remove}
      />
      <SelectionActions
        annotations={annotations}
        onAddToConversation={(next) =>
          setAnnotations((items) => [...items, next])
        }
        onUpdateAnnotation={update}
        onRemoveAnnotation={remove}
        onAskInSideChat={vi.fn()}
      />
    </>
  )
}

it("keeps a new annotation at its source and preserves its note when returning to the main composer", async () => {
  const user = userEvent.setup()
  render(<Draft />)
  selectText(screen.getByText("useful explanation"))
  await user.click(screen.getByRole("button", { name: "Add to conversation" }))
  expect(
    screen.getByRole("button", { name: "Edit annotation 1" }).textContent,
  ).toBe("1")
  expect(document.querySelector(".annotation-highlight")).not.toBeNull()
  const comment = screen.getByRole("textbox", {
    name: "Annotation comment (optional)",
  })
  expect(document.activeElement).toBe(comment)
  await user.type(comment, "Focus on correctness.")
  await user.click(screen.getByRole("button", { name: "Main composer" }))
  expect(screen.queryByRole("textbox")).toBeNull()
  await user.click(screen.getByRole("button", { name: "1 annotation" }))
  await user.click(
    within(screen.getByRole("dialog", { name: "annotations" })).getByRole(
      "button",
      { name: "Edit annotation 1" },
    ),
  )
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Focus on correctness.",
  )
})

it("Escape removes a just-created annotation but restores the existing note during editing", async () => {
  const user = userEvent.setup()
  render(<Draft />)
  selectText(screen.getByText("useful explanation"))
  await user.click(screen.getByRole("button", { name: "Add to conversation" }))
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("button", { name: "Edit annotation 1" })).toBeNull()
  selectText(screen.getByText("useful explanation"))
  await user.click(screen.getByRole("button", { name: "Add to conversation" }))
  await user.type(screen.getByRole("textbox"), "Saved note")
  await user.keyboard("{Enter}")
  await user.click(screen.getByRole("button", { name: "Edit annotation 1" }))
  await user.type(screen.getByRole("textbox"), " changed")
  await user.keyboard("{Escape}")
  await user.click(screen.getByRole("button", { name: "Edit annotation 1" }))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Saved note",
  )
})

it("numbers current annotations and removes highlights and editor when the main draft changes", () => {
  const second = {
    ...annotation,
    id: "annotation_two",
    text: "A",
    anchor: { startOffset: 0, endOffset: 1 },
  }
  const view = render(
    <>
      <p {...contextSourceAttributes(source)}>A useful explanation.</p>
      <AnnotationLayer
        annotations={[annotation, second]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />
    </>,
  )
  expect(
    screen.getByRole("button", { name: "Edit annotation 1" }).textContent,
  ).toBe("1")
  expect(
    screen.getByRole("button", { name: "Edit annotation 2" }).textContent,
  ).toBe("2")
  act(() => requestAnnotationEdit(annotation.id))
  expect(screen.getByRole("textbox")).toBeDefined()
  view.rerender(
    <AnnotationLayer annotations={[]} onChange={vi.fn()} onRemove={vi.fn()} />,
  )
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(document.querySelector(".annotation-highlight")).toBeNull()
})

it("rechecks source mutations and hides an annotation when its saved text no longer matches", async () => {
  render(
    <>
      <p {...contextSourceAttributes(source)}>A useful explanation.</p>
      <AnnotationLayer
        annotations={[annotation]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />
    </>,
  )
  const element = screen.getByText("A useful explanation.")
  expect(
    screen.getByRole("button", { name: "Edit annotation 1" }),
  ).toBeDefined()
  act(() => {
    element.textContent = "A changed explanation."
  })
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Edit annotation 1" }),
    ).toBeNull(),
  )
  expect(document.querySelector(".annotation-highlight")).toBeNull()
})

it("aggregates annotations and selected text into compact read-only preview pills", async () => {
  const user = userEvent.setup()
  render(
    <ContextExcerptChips
      excerpts={[
        annotation,
        { ...annotation, id: "two" },
        {
          kind: "selection",
          id: "selection",
          source,
          text: "Other selected text",
        },
      ]}
    />,
  )
  expect(screen.getByRole("button", { name: "2 annotations" })).toBeDefined()
  expect(
    screen.getByRole("button", { name: "1 selected text snippet" }),
  ).toBeDefined()
  expect(screen.queryByRole("dialog")).toBeNull()
  await user.click(screen.getByRole("button", { name: "2 annotations" }))
  expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull()
  expect(screen.queryByRole("button", { name: /Edit annotation/ })).toBeNull()
  expect(screen.getAllByText("useful explanation")).toHaveLength(2)
})
