// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SessionElicitation } from "../../src/gui/components/session-elicitation.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"

const { request, openUrlTarget } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
  openUrlTarget:
    vi.fn<(target: { kind: "url"; url: string }) => Promise<void>>(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))
vi.mock("../../src/gui/lib/open-resource.ts", () => ({ openUrlTarget }))

function session(id: string): ApiSessionDetail {
  return {
    id,
    conversationId: `conversation-${id}`,
    workingDirectory: "/repo",
    title: id,
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    seq: 1,
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      turns: 0,
      inputs: 0,
      tools: 0,
      pendingInputs: 0,
      items: 0,
      permissions: 0,
    },
  }
}

function form(requestedSchema: unknown) {
  return {
    requestId: "request-1",
    serverName: "docs",
    params: { message: "Choose your preferences", requestedSchema },
  }
}

function formResponse(requestedSchema: unknown) {
  return { requests: [form(requestedSchema)] }
}

function answerCalls() {
  return request.mock.calls.filter(
    ([method]) => method === "session/elicitation/answer",
  )
}

beforeEach(() => {
  request.mockReset().mockResolvedValue({ requests: [] })
  openUrlTarget.mockReset().mockResolvedValue()
  useAppStore.setState({
    ...createInitialAppState(),
    selectedSession: session("work"),
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(createInitialAppState())
})

it("submits typed fields, enum titles and defaults while omitting unanswered optional values", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue(
    formResponse({
      type: "object",
      required: ["name", "count", "enabled"],
      properties: {
        name: { type: "string", title: "Name", default: "Ada" },
        count: { type: "integer", title: "Count" },
        ratio: { type: "number", title: "Ratio", default: 0.5 },
        enabled: { type: "boolean", title: "Enabled", default: false },
        plan: {
          type: "string",
          title: "Plan",
          oneOf: [
            { const: "free", title: "Free" },
            { const: "paid", title: "Paid" },
          ],
          default: "free",
        },
        color: { type: "string", title: "Color", enum: ["red", "blue"] },
        regions: {
          type: "array",
          title: "Regions",
          items: { type: "string", enum: ["us", "eu"] },
          default: ["us"],
        },
        topics: {
          type: "array",
          title: "Topics",
          items: {
            anyOf: [
              { const: "api", title: "API" },
              { const: "sdk", title: "SDK" },
            ],
          },
        },
        optional: { type: "string", title: "Optional notes" },
        optionalBoolean: { type: "boolean", title: "Optional choice" },
      },
    }),
  )
  render(<SessionElicitation />)
  await screen.findByText("Choose your preferences")
  await user.type(
    screen.getByRole("spinbutton", { name: "Count (required)" }),
    "3",
  )
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Plan" }),
    "Paid",
  )
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Color" }),
    "blue",
  )
  await user.selectOptions(screen.getByRole("listbox", { name: "Topics" }), [
    "API",
    "SDK",
  ])
  expect(answerCalls()).toHaveLength(0)
  await user.click(screen.getByRole("button", { name: "Submit" }))
  expect(answerCalls()).toEqual([
    [
      "session/elicitation/answer",
      {
        sessionId: "work",
        requestId: "request-1",
        result: {
          action: "accept",
          content: {
            name: "Ada",
            count: 3,
            ratio: 0.5,
            enabled: false,
            plan: "paid",
            color: "blue",
            regions: ["us"],
            topics: ["api", "sdk"],
          },
        },
      },
    ],
  ])
  expect(screen.queryByText("Choose your preferences")).toBeNull()
})

it("validates required fields, integer bounds and multiselect limits before answering", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue(
    formResponse({
      type: "object",
      required: ["name", "count", "choice"],
      properties: {
        name: { type: "string", title: "Name", minLength: 3 },
        count: { type: "integer", title: "Count", minimum: 2, maximum: 5 },
        choice: { type: "boolean", title: "Choice" },
        tags: {
          type: "array",
          title: "Tags",
          minItems: 1,
          maxItems: 1,
          items: { type: "string", enum: ["a", "b"] },
        },
      },
    }),
  )
  render(<SessionElicitation />)
  await user.click(await screen.findByRole("button", { name: "Submit" }))
  expect(screen.getAllByText("This field is required.")).toHaveLength(3)
  expect(answerCalls()).toHaveLength(0)
  await user.type(
    screen.getByRole("textbox", { name: "Name (required)" }),
    "Al",
  )
  const count = screen.getByRole("spinbutton", { name: "Count (required)" })
  await user.type(count, "2.5")
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Choice (required)" }),
    "No",
  )
  const tags = screen.getByRole("listbox", { name: "Tags" })
  await user.selectOptions(tags, ["a", "b"])
  await user.click(screen.getByRole("button", { name: "Submit" }))
  expect(screen.getByText("Enter at least 3 characters.")).toBeDefined()
  expect(screen.getByText("Enter a whole number.")).toBeDefined()
  expect(screen.getByText("Choose at most 1 option(s).")).toBeDefined()
  await user.clear(count)
  await user.type(count, "6")
  await user.click(screen.getByRole("button", { name: "Submit" }))
  expect(screen.getByText("Enter a value of at most 5.")).toBeDefined()
  expect(answerCalls()).toHaveLength(0)
  await user.type(screen.getByRole("textbox", { name: "Name (required)" }), "i")
  await user.clear(count)
  await user.type(count, "3")
  await user.deselectOptions(tags, "b")
  await user.click(screen.getByRole("button", { name: "Submit" }))
  expect(answerCalls()[0]?.[1]).toMatchObject({
    result: {
      action: "accept",
      content: { name: "Ali", count: 3, choice: false, tags: ["a"] },
    },
  })
})

it.each([
  { type: "object", properties: { nested: { type: "object" } } },
  { type: "object", properties: { code: { type: "string", pattern: "^a" } } },
  {
    type: "object",
    properties: { items: { type: "array", items: { type: "number" } } },
  },
  { type: "object", properties: {}, required: ["missing"] },
])("rejects unsupported schemas while allowing decline: %j", async (schema) => {
  const user = userEvent.setup()
  request.mockResolvedValue(formResponse(schema))
  render(<SessionElicitation />)
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("cannot be displayed"),
  )
  expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty(
    "disabled",
    true,
  )
  await user.click(screen.getByRole("button", { name: "Decline" }))
  expect(answerCalls()[0]?.[1]).toEqual({
    sessionId: "work",
    requestId: "request-1",
    result: { action: "decline" },
  })
})

it("opens URL requests without accepting and sends Done only after an explicit click", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({
    requests: [
      {
        requestId: "browser-request",
        serverName: "docs",
        params: {
          mode: "url",
          message: "Verify access",
          elicitationId: "access",
          url: "https://docs.example/verify?request=1",
        },
      },
    ],
  })
  openUrlTarget.mockRejectedValueOnce(new Error("Could not open browser"))
  render(<SessionElicitation />)
  const open = await screen.findByRole("button", { name: "Open docs.example" })
  await user.click(open)
  expect(await screen.findByText("Could not open browser")).toBeDefined()
  expect(answerCalls()).toHaveLength(0)
  await user.click(open)
  expect(openUrlTarget).toHaveBeenLastCalledWith({
    kind: "url",
    url: "https://docs.example/verify?request=1",
  })
  expect(screen.queryByText("Could not open browser")).toBeNull()
  expect(answerCalls()).toHaveLength(0)
  await user.click(screen.getByRole("button", { name: "Done" }))
  expect(answerCalls()[0]?.[1]).toEqual({
    sessionId: "work",
    requestId: "browser-request",
    result: { action: "accept" },
  })
})

it("keeps unsupported URL requests cancellable without opening or accepting them", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({
    requests: [
      {
        requestId: "bad-url",
        serverName: "docs",
        params: {
          mode: "url",
          message: "Open this",
          elicitationId: "bad",
          url: "javascript:alert(1)",
        },
      },
    ],
  })
  render(<SessionElicitation />)
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("unsupported URL"),
  )
  expect(screen.getByRole("button", { name: "Done" })).toHaveProperty(
    "disabled",
    true,
  )
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(openUrlTarget).not.toHaveBeenCalled()
  expect(answerCalls()[0]?.[1]).toMatchObject({
    requestId: "bad-url",
    result: { action: "cancel" },
  })
})

it("polls outside active turns, preserves edits, and cannot resurrect an answered request", async () => {
  vi.useFakeTimers()
  const response = formResponse({
    type: "object",
    properties: { name: { type: "string", title: "Name", default: "Initial" } },
  })
  let resolveStale!: (response: unknown) => void
  const stale = new Promise<unknown>((resolve) => {
    resolveStale = resolve
  })
  let reads = 0
  request.mockImplementation(async (method) => {
    if (method === "session/elicitation/answer") return {}
    reads++
    return reads === 1 ? { requests: [] } : reads === 4 ? stale : response
  })
  const view = render(<SessionElicitation />)
  await act(async () => {})
  expect(screen.queryByRole("region", { name: "MCP requests" })).toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(2_000))
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Edited" },
  })
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty(
    "value",
    "Edited",
  )
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Submit" })),
  )
  expect(screen.queryByText("Choose your preferences")).toBeNull()
  await act(async () => resolveStale(response))
  expect(screen.queryByText("Choose your preferences")).toBeNull()
  view.unmount()
  const calls = request.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(request.mock.calls).toHaveLength(calls)
})

it("ignores old session requests and reports list failures until a later refresh succeeds", async () => {
  vi.useFakeTimers()
  let resolveOld!: (response: unknown) => void
  const old = new Promise<unknown>((resolve) => {
    resolveOld = resolve
  })
  let fail = true
  request.mockImplementation(async (_method, params) => {
    if (params.sessionId === "work") return old
    if (fail) throw new Error("Requests are unavailable")
    return { requests: [] }
  })
  render(<SessionElicitation />)
  act(() => useAppStore.setState({ selectedSession: session("next") }))
  await act(async () => {})
  expect(screen.getByRole("alert").textContent).toBe("Requests are unavailable")
  await act(async () =>
    resolveOld(formResponse({ type: "object", properties: {} })),
  )
  expect(screen.queryByText("Choose your preferences")).toBeNull()
  fail = false
  await act(async () => vi.advanceTimersByTimeAsync(2_000))
  expect(screen.queryByRole("alert")).toBeNull()
})

it("keeps input after a rejected answer and prevents duplicate submissions", async () => {
  const user = userEvent.setup()
  let resolveAnswer!: (response: unknown) => void
  const inFlight = new Promise<unknown>((resolve) => {
    resolveAnswer = resolve
  })
  let rejected = false
  request.mockImplementation(async (method) => {
    if (method === "session/elicitation/list")
      return formResponse({
        type: "object",
        properties: { name: { type: "string", title: "Name" } },
      })
    if (!rejected) {
      rejected = true
      throw new Error("Please choose another name")
    }
    return inFlight
  })
  render(<SessionElicitation />)
  await user.type(await screen.findByRole("textbox", { name: "Name" }), "Ada")
  await user.click(screen.getByRole("button", { name: "Submit" }))
  expect(await screen.findByText("Please choose another name")).toBeDefined()
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty(
    "value",
    "Ada",
  )
  await user.click(screen.getByRole("button", { name: "Submit" }))
  expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty(
    "disabled",
    true,
  )
  await user.click(screen.getByRole("button", { name: "Submit" }))
  expect(answerCalls()).toHaveLength(2)
  await act(async () => resolveAnswer({}))
  expect(screen.queryByText("Choose your preferences")).toBeNull()
})
