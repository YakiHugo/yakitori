// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { HistoryMatchDialog } from "../../src/gui/components/history-match-dialog.tsx"
import { SessionSearch } from "../../src/gui/components/session-search.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))

beforeEach(() => {
  request.mockReset()
  useAppStore.setState(createInitialAppState())
})
afterEach(cleanup)

it("opens healthy results while showing that unreadable conversations were omitted", async () => {
  const selectSession = vi.fn(async () => {})
  const onClose = vi.fn()
  useAppStore.setState({ selectSession })
  const session = {
    id: "session_found",
    conversationId: "session_found",
    seq: 1,
    title: "Project search result",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  }
  request.mockResolvedValue({
    data: [{ session, snippet: "matching conversation" }],
    unavailableSessionCount: 2,
  })
  const user = userEvent.setup()
  render(<SessionSearch onClose={onClose} />)
  await user.type(
    screen.getByRole("textbox", { name: "Search sessions" }),
    "project",
  )
  const result = await screen.findByRole("button", {
    name: /Project search result/,
  })
  expect(
    screen.getByText(/Partial results · 2 conversations could not be searched/),
  ).toBeDefined()
  await user.click(result)
  expect(onClose).toHaveBeenCalledOnce()
  expect(selectSession).toHaveBeenCalledWith("session_found", session)
})

it("distinguishes an incomplete empty search from a complete search with no matches", async () => {
  request.mockResolvedValue({ data: [], unavailableSessionCount: 1 })
  const user = userEvent.setup()
  render(<SessionSearch onClose={() => {}} />)
  const input = screen.getByRole("textbox", { name: "Search sessions" })
  await user.type(input, "missing")
  await screen.findByText("No matching sessions")
  expect(
    screen.getByText(/Partial results · 1 conversation could not be searched/),
  ).toBeDefined()

  request.mockResolvedValue({ data: [] })
  await user.clear(input)
  await user.type(input, "another")
  await screen.findByText("No matching sessions")
  expect(screen.queryByText(/Partial results/)).toBeNull()
})

it("reads a body result at its history location before opening the conversation", async () => {
  const selectSession = vi.fn(async () => {})
  useAppStore.setState({ selectSession })
  const session = {
    id: "session_found",
    rolloutId: "rollout_current",
    conversationId: "session_found",
    seq: 42,
    title: "Found work",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  }
  const location = {
    rolloutId: session.rolloutId,
    turnId: "turn_old",
    itemId: "input_old",
  }
  request
    .mockResolvedValueOnce({
      data: [{ session, location, snippet: "saved discussion" }],
    })
    .mockResolvedValueOnce({ events: [], historyAfter: 21 })
    .mockResolvedValueOnce({ events: [], historyBefore: 15 })
  const user = userEvent.setup()
  render(
    <>
      <SessionSearch onClose={() => {}} />
      <HistoryMatchDialog />
    </>,
  )
  await user.type(
    screen.getByRole("textbox", { name: "Search sessions" }),
    "discussion",
  )
  await user.click(await screen.findByRole("button", { name: /Found work/ }))
  const later = await screen.findByRole("button", { name: "Later" })
  await waitFor(() => expect((later as HTMLButtonElement).disabled).toBe(false))
  expect(request).toHaveBeenNthCalledWith(2, "session/history", {
    sessionId: session.id,
    location,
  })
  await user.click(later)
  expect(request).toHaveBeenNthCalledWith(3, "session/history", {
    sessionId: session.id,
    location,
    after: 21,
  })
  expect(selectSession).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Open conversation" }))
  expect(selectSession).toHaveBeenCalledWith(session.id, session)
})

it("discards old search successes and failures after a newer query is displayed", async () => {
  let resolveOld: ((value: { data: [] }) => void) | undefined
  let rejectOld: ((cause: Error) => void) | undefined
  request.mockImplementation(
    (_method: string, params: { searchTerm: string }) => {
      if (params.searchTerm === "old-success")
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      if (params.searchTerm === "old-error")
        return new Promise((_resolve, reject) => {
          rejectOld = reject
        })
      return Promise.resolve({ data: [] })
    },
  )
  render(<SessionSearch onClose={() => {}} />)
  const input = screen.getByRole("textbox", { name: "Search sessions" })
  fireEvent.change(input, { target: { value: "old-success" } })
  await waitFor(() => expect(resolveOld).toBeDefined())
  fireEvent.change(input, { target: { value: "old-error" } })
  await waitFor(() => expect(rejectOld).toBeDefined())
  fireEvent.change(input, { target: { value: "new" } })
  await screen.findByText("No matching sessions")
  await act(async () => {
    resolveOld?.({ data: [] })
    rejectOld?.(new Error("Outdated failure"))
  })
  expect(screen.getByText("No matching sessions")).toBeDefined()
  expect(screen.queryByText("Outdated failure")).toBeNull()
  expect(screen.queryByRole("button", { name: "Retry search" })).toBeNull()
})

it("does not append an old page after the archive filter changes", async () => {
  const summary = (id: string) => ({
    session: {
      id,
      conversationId: id,
      seq: 1,
      title: id,
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
    },
    snippet: id,
  })
  let finishPage: ((value: unknown) => void) | undefined
  request.mockImplementation(
    (_method: string, params: { archived: boolean; cursor?: string }) => {
      if (params.cursor)
        return new Promise((resolve) => {
          finishPage = resolve
        })
      return Promise.resolve(
        params.archived
          ? { data: [summary("Archived")] }
          : { data: [summary("Current")], nextCursor: "next" },
      )
    },
  )
  render(<SessionSearch onClose={() => {}} />)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "term" } })
  fireEvent.click(
    await screen.findByRole("button", { name: "Show more results" }),
  )
  expect(finishPage).toBeDefined()
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Search archived conversations" }),
  )
  await screen.findByRole("button", { name: /Archived/ })
  await act(async () => finishPage?.({ data: [summary("Old page")] }))
  expect(screen.queryByRole("button", { name: /Current|Old page/ })).toBeNull()
  expect(screen.getByRole("button", { name: /Archived/ })).toBeDefined()
})

it("resets keyboard selection when retry replaces paginated results with a fresh first page", async () => {
  const summary = (id: string) => ({
    session: {
      id,
      conversationId: id,
      seq: 1,
      title: id,
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
    },
    snippet: id,
  })
  const selectSession = vi.fn(async () => {})
  useAppStore.setState({ selectSession })
  request
    .mockResolvedValueOnce({ data: [summary("First")], nextCursor: "second" })
    .mockResolvedValueOnce({ data: [summary("Second")], nextCursor: "third" })
    .mockRejectedValueOnce(new Error("Page unavailable"))
    .mockResolvedValueOnce({ data: [summary("First")], nextCursor: "second" })
  render(<SessionSearch onClose={() => {}} />)
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "term" } })
  fireEvent.click(
    await screen.findByRole("button", { name: "Show more results" }),
  )
  const second = await screen.findByRole("button", {
    name: "Second Second No project",
  })
  fireEvent.mouseEnter(second)
  fireEvent.click(screen.getByRole("button", { name: "Show more results" }))
  fireEvent.click(await screen.findByRole("button", { name: "Retry search" }))
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Second Second No project" }),
    ).toBeNull(),
  )
  expect(
    screen
      .getByRole("button", { name: "First First No project" })
      .getAttribute("data-active"),
  ).toBe("true")
  fireEvent.keyDown(input, { key: "Enter" })
  expect(selectSession).toHaveBeenCalledExactlyOnceWith(
    "First",
    summary("First").session,
  )
})
