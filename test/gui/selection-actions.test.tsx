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
import { UserMessageCell } from "../../src/gui/components/cells/user-message-cell.tsx"
import { ContextExcerptCards } from "../../src/gui/components/context-excerpt-cards.tsx"
import {
  ExcerptSourceLayer,
  findContextSource,
  requestExcerptEdit,
  resolveExcerptRange,
  selectionOffsets,
} from "../../src/gui/components/excerpt-source.tsx"
import { SelectionActions } from "../../src/gui/components/selection-actions.tsx"
import {
  type ContextExcerpt,
  contextSourceAttributes,
} from "../../src/gui/conversation-context.ts"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const source = {
  kind: "message",
  label: "Assistant message",
  sessionId: "main",
  messageId: "answer",
} as const
const excerpt: ContextExcerpt = {
  id: "excerpt_one",
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
const actions = () => ({
  onAddToConversation: vi.fn(),
  onAskInSideChat: vi.fn(),
})

it.each([
  "Quote in conversation",
  "Ask in side chat",
])("%s immediately attaches the same anchored excerpt without requiring a comment", async (action) => {
  const props = actions()
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
  await userEvent.setup().click(screen.getByRole("button", { name: action }))
  const callback =
    action === "Quote in conversation"
      ? props.onAddToConversation
      : props.onAskInSideChat
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "useful explanation",
      source,
      anchor: { startOffset: 2, endOffset: 20 },
    }),
  )
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(window.getSelection()?.isCollapsed).toBe(true)
})

it("routes a side conversation selection by its owning tab rather than its source session", async () => {
  const props = actions()
  render(
    <>
      <div data-side-chat-id="side-tab">
        <p {...contextSourceAttributes(source)}>Side response</p>
      </div>
      <SelectionActions {...props} />
    </>,
  )
  selectText(screen.getByText("Side response"))
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Quote in conversation" }))
  expect(props.onAddToConversation).toHaveBeenCalledWith(
    expect.objectContaining({ source }),
    "side-tab",
  )
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
      <SelectionActions {...actions()} />
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

it.each([
  "hidden",
  "changed",
])("rejects a captured selection after its source is %s", async (mutation) => {
  const props = actions()
  render(
    <>
      <p {...contextSourceAttributes(source)}>Original response</p>
      <SelectionActions {...props} />
    </>,
  )
  const element = screen.getByText("Original response")
  selectText(element)
  if (mutation === "hidden") element.hidden = true
  else element.textContent = "Replaced response"
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Quote in conversation" }))
  expect(props.onAddToConversation).not.toHaveBeenCalled()
})

it("resolves UTF-16 offsets across replacement nodes and refuses a changed quote", () => {
  const element = document.createElement("p")
  element.innerHTML = "A <span>useful <strong>explanation</strong></span>."
  const range = document.createRange()
  const selected = element.querySelector("span")
  if (!selected) throw new Error("Missing selected source")
  range.selectNodeContents(selected)
  expect(selectionOffsets(element, range)).toEqual({
    startOffset: 2,
    endOffset: 20,
  })
  element.innerHTML = "<span>A useful</span><em> explanation.</em>"
  expect(resolveExcerptRange(element, excerpt)?.toString()).toBe(
    "useful explanation",
  )
  element.textContent = "A changed explanation."
  expect(resolveExcerptRange(element, excerpt)).toBeUndefined()
})

it("finds a source by identity even when its display label changes", () => {
  render(
    <p {...contextSourceAttributes({ ...source, label: "Renamed response" })}>
      Text
    </p>,
  )
  expect(findContextSource(source)).toBe(screen.getByText("Text"))
})

function Draft({
  ownerId = "main",
  showSource = true,
}: {
  ownerId?: string
  showSource?: boolean
}) {
  const [excerpts, setExcerpts] = useState<ContextExcerpt[]>([excerpt])
  return (
    <>
      {showSource ? (
        <p {...contextSourceAttributes(source)}>A useful explanation.</p>
      ) : null}
      <ContextExcerptCards
        ownerId={ownerId}
        excerpts={excerpts}
        onChange={(next) =>
          setExcerpts((items) =>
            items.map((item) => (item.id === next.id ? next : item)),
          )
        }
        onRemove={(id) =>
          setExcerpts((items) => items.filter((item) => item.id !== id))
        }
      />
      <ExcerptSourceLayer
        items={excerpts.map((excerpt, index) => ({
          excerpt,
          ownerId,
          number: index + 1,
          conversation: "main conversation",
        }))}
      />
    </>
  )
}

it("edits and clears comments without a mounted source, and Escape discards an unsaved edit", async () => {
  const user = userEvent.setup()
  render(<Draft showSource={false} />)
  const open = () =>
    user.click(
      screen.getByRole("button", { name: "Open excerpt 1: Assistant message" }),
    )
  await open()
  expect(screen.getByText(/cannot be located precisely/)).toBeDefined()
  await user.type(screen.getByRole("textbox"), "Saved feedback")
  await user.click(screen.getByRole("button", { name: "Save comment" }))
  await open()
  await user.type(screen.getByRole("textbox"), " discarded")
  await user.keyboard("{Escape}")
  await open()
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Saved feedback",
  )
  await user.clear(screen.getByRole("textbox"))
  await user.keyboard("{Enter}")
  expect(screen.queryByText("Saved feedback")).toBeNull()
})

it("opens the same editor from the source marker and removes its derived highlight with the excerpt", async () => {
  render(<Draft />)
  const user = userEvent.setup()
  await user.click(
    screen.getByRole("button", { name: "Open excerpt 1 in main conversation" }),
  )
  expect(document.activeElement).toBe(screen.getByRole("textbox"))
  await user.type(screen.getByRole("textbox"), "Feedback")
  await user.keyboard("{Enter}")
  expect(document.querySelector(".excerpt-highlight")).not.toBeNull()
  await user.click(screen.getByRole("button", { name: "Remove excerpt 1" }))
  await waitFor(() =>
    expect(document.querySelector(".excerpt-highlight")).toBeNull(),
  )
})

it("scopes source edit requests to one draft even when two drafts reference the same excerpt ID", async () => {
  render(
    <>
      <Draft ownerId="main" showSource={false} />
      <Draft ownerId="side" showSource={false} />
    </>,
  )
  act(() => requestExcerptEdit({ ownerId: "side", excerptId: excerpt.id }))
  expect(screen.getAllByRole("dialog")).toHaveLength(1)
  await userEvent.setup().type(screen.getByRole("textbox"), "Side only")
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Save comment" }))
  act(() => requestExcerptEdit({ ownerId: "main", excerptId: excerpt.id }))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("")
})

it("stops highlighting a source that has changed without losing the editable snapshot", async () => {
  render(<Draft />)
  act(() => {
    screen.getByText("A useful explanation.").textContent =
      "A changed explanation."
  })
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "Open excerpt 1 in main conversation",
      }),
    ).toBeNull(),
  )
  await userEvent
    .setup()
    .click(
      screen.getByRole("button", { name: "Open excerpt 1: Assistant message" }),
    )
  expect(
    within(screen.getByRole("dialog")).getByText("useful explanation"),
  ).toBeDefined()
})

it("shows each saved excerpt in order with a read-only original comment", async () => {
  render(
    <ContextExcerptCards
      excerpts={[
        { ...excerpt, comment: "Saved" },
        {
          id: "browser",
          text: "A page quote",
          source: {
            kind: "browser",
            label: "Page",
            url: "https://example.com",
          },
        },
      ]}
    />,
  )
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Open excerpt 1: Assistant message", "Open excerpt 2: Page"])
  await userEvent
    .setup()
    .click(
      screen.getByRole("button", { name: "Open excerpt 1: Assistant message" }),
    )
  expect(within(screen.getByRole("dialog")).getByText("Saved")).toBeDefined()
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull()
})

it("captures UTF-16 offsets in user message text containing Unicode", async () => {
  useAppStore.setState({ selection: { sessionId: "session_1" } })
  const props = actions()
  const { container } = render(
    <>
      <UserMessageCell
        queued={false}
        entry={{
          kind: "user_input",
          inputId: "input_1",
          at: "2026-10-08T00:00:00Z",
          text: "Before Selected 😀 passage",
          content: inputFixture([
            { type: "text", text: "Before Selected 😀 passage" },
          ]),
        }}
      />
      <SelectionActions {...props} />
    </>,
  )
  const element = container.querySelector<HTMLElement>(
    "[data-context-kind=message]",
  )
  const node = element?.querySelector("p")?.firstChild
  if (!element || !node) throw new Error("Missing user text")
  const range = document.createRange()
  range.setStart(node, 7)
  range.setEnd(node, 26)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  fireEvent.pointerUp(element)
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Quote in conversation" }))
  const captured = props.onAddToConversation.mock
    .calls[0]?.[0] as ContextExcerpt
  expect(captured).toMatchObject({
    text: "Selected 😀 passage",
    anchor: { startOffset: 7, endOffset: 26 },
    source: { sessionId: "session_1", messageId: "input_1" },
  })
  expect(resolveExcerptRange(element, captured)?.toString()).toBe(
    "Selected 😀 passage",
  )
})
