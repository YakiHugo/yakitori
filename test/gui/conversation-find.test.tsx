// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  ConversationFind,
  openConversationFind,
} from "../../src/gui/components/conversation-find.tsx"
import { conversationFindRanges } from "../../src/gui/components/conversation-find-text.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ApiSearchSessionOccurrencesResponse } from "../../src/server/protocol.ts"

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))

const highlights = new Map<string, Set<Range>>()
const jump = vi.fn()
const hits: ApiSearchSessionOccurrencesResponse["data"] = [
  {
    turnId: "turn",
    itemId: "prompt",
    snippet: "Needle then needle",
    snippetMatchRange: { start: 0, end: 6 },
  },
  {
    turnId: "turn",
    itemId: "prompt",
    snippet: "Needle then needle",
    snippetMatchRange: { start: 12, end: 18 },
  },
  {
    turnId: "turn",
    itemId: "answer",
    snippet: "Final needle",
    snippetMatchRange: { start: 6, end: 12 },
  },
]

function Fixture({ sessionId = "session" }: Readonly<{ sessionId?: string }>) {
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <input aria-label="Composer" />
      <div className="cm-editor">
        <input aria-label="File editor" />
      </div>
      <ConversationFind
        key={sessionId}
        sessionId={sessionId}
        contentRef={contentRef}
        onJump={jump}
      />
      <div ref={contentRef}>
        <div data-context-kind="message" data-context-message-id="prompt">
          <p>Needle then needle</p>
        </div>
        <div data-context-kind="message" data-context-message-id="answer">
          <p>
            <strong>Final</strong> needle
          </p>
        </div>
        <div data-context-kind="message" data-context-message-id="commentary">
          <p>Commentary needle</p>
        </div>
        <details>
          <summary>Earlier message</summary>
          <div data-context-kind="message" data-context-message-id="older">
            <p>Historical needle</p>
          </div>
        </details>
      </div>
    </>
  )
}

beforeEach(() => {
  request.mockReset()
  jump.mockReset()
  highlights.clear()
  useAppStore.setState(createInitialAppState())
  vi.stubGlobal("CSS", { highlights })
  vi.stubGlobal("Highlight", class extends Set<Range> {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it.each([
  "metaKey",
  "ctrlKey",
])("opens from %s+F and restores focus on Escape", (modifier) => {
  render(<Fixture />)
  const composer = screen.getByRole("textbox", { name: "Composer" })
  composer.focus()
  fireEvent.keyDown(composer, { key: "f", [modifier]: true })
  const find = screen.getByRole("searchbox", { name: "Find in conversation" })
  expect(document.activeElement).toBe(find)
  fireEvent.keyDown(find, { key: "Escape" })
  expect(screen.queryByRole("search")).toBeNull()
  expect(document.activeElement).toBe(composer)
})

it("leaves the file editor shortcut and already-handled shortcuts alone", () => {
  render(<Fixture />)
  fireEvent.keyDown(screen.getByRole("textbox", { name: "File editor" }), {
    key: "f",
    metaKey: true,
  })
  expect(screen.queryByRole("search")).toBeNull()
  const handled = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
  })
  handled.preventDefault()
  fireEvent(window, handled)
  expect(screen.queryByRole("search")).toBeNull()
  act(openConversationFind)
  expect(screen.getByRole("search")).toBeDefined()
})

it("loads every persisted occurrence page and navigates individual matches in both directions", async () => {
  request
    .mockResolvedValueOnce({ data: hits.slice(0, 2), nextCursor: "next" })
    .mockResolvedValueOnce({ data: hits.slice(2) })
  render(<Fixture />)
  act(openConversationFind)
  const input = screen.getByRole("searchbox")
  fireEvent.change(input, { target: { value: "needle" } })
  await screen.findByText("1 of 3")
  expect(request).toHaveBeenLastCalledWith("session/searchOccurrences", {
    sessionId: "session",
    searchTerm: "needle",
    limit: 100,
    cursor: "next",
  })
  expect(highlights.get("conversation-find")?.size).toBe(3)
  expect(
    [...(highlights.get("conversation-find-current") ?? [])][0]?.toString(),
  ).toBe("Needle")
  fireEvent.keyDown(input, { key: "Enter" })
  expect(screen.getByText("2 of 3")).toBeDefined()
  expect(
    [...(highlights.get("conversation-find-current") ?? [])][0]?.toString(),
  ).toBe("needle")
  fireEvent.click(screen.getByRole("button", { name: "Next match" }))
  expect(screen.getByText("3 of 3")).toBeDefined()
  expect(
    document
      .querySelector("[data-find-current]")
      ?.getAttribute("data-context-message-id"),
  ).toBe("answer")
  fireEvent.keyDown(input, { key: "Enter" })
  expect(screen.getByText("1 of 3")).toBeDefined()
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
  expect(screen.getByText("3 of 3")).toBeDefined()
  expect(jump).toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Close find" }))
  expect(highlights.size).toBe(0)
  expect(document.querySelector("[data-find-current]")).toBeNull()
})

it("reveals an older logical message inside a closed disclosure before jumping", async () => {
  request.mockResolvedValue({
    data: [{ ...hits[2], itemId: "older", snippet: "Historical needle" }],
  })
  const { container } = render(<Fixture />)
  act(openConversationFind)
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "needle" },
  })
  await screen.findByText("1 of 1")
  expect(container.querySelector("details")?.open).toBe(true)
  expect(
    document
      .querySelector("[data-find-current]")
      ?.getAttribute("data-context-message-id"),
  ).toBe("older")
  expect(jump).toHaveBeenCalledOnce()
})

it("ignores a response for an earlier query and resets when the selected session changes", async () => {
  let resolveOld:
    | ((value: ApiSearchSessionOccurrencesResponse) => void)
    | undefined
  request.mockImplementation(
    (_method: string, params: { searchTerm: string }) =>
      params.searchTerm === "old"
        ? new Promise<ApiSearchSessionOccurrencesResponse>((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve({ data: hits }),
  )
  const { rerender } = render(<Fixture />)
  act(openConversationFind)
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old" } })
  await waitFor(() => expect(resolveOld).toBeDefined())
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "needle" },
  })
  await screen.findByText("1 of 3")
  await act(async () => resolveOld?.({ data: [] }))
  expect(screen.getByText("1 of 3")).toBeDefined()
  rerender(<Fixture sessionId="other" />)
  expect(screen.queryByRole("search")).toBeNull()
  expect(highlights.size).toBe(0)
})

it("shows an operational failure with retry, and distinguishes a completed empty search", async () => {
  request
    .mockRejectedValueOnce(new Error("Search projection unavailable"))
    .mockResolvedValueOnce({ data: [] })
  render(<Fixture />)
  act(openConversationFind)
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "needle" },
  })
  await screen.findByRole("alert")
  expect(screen.getByText("Search projection unavailable")).toBeDefined()
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  await screen.findByText("No results")
  expect(screen.queryByRole("alert")).toBeNull()
  expect(
    (screen.getByRole("button", { name: "Next match" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
})

it("locates phrases across Markdown nodes and code spans without including controls", () => {
  const root = document.createElement("div")
  root.innerHTML =
    "<h2>Final</h2><p><strong>needle</strong> <em>across</em> lines</p><pre><button>Copy needle</button><code><span>needle</span>\n<span>in code</span></code></pre>"
  expect(
    conversationFindRanges(root, "Final needle across lines"),
  ).toHaveLength(1)
  expect(conversationFindRanges(root, "needle")).toHaveLength(2)
  expect(conversationFindRanges(root, "needle in code")).toHaveLength(1)
  expect(conversationFindRanges(root, "copy")).toHaveLength(0)
  expect(conversationFindRanges(root, "")).toHaveLength(0)
})
