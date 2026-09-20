// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
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
