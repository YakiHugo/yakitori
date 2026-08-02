// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createEventEnvelope, EventType, InputRole } from "../../src/index.ts"
import { projectExecutionView } from "../../src/gui/execution-view.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"

type Listener = (event: unknown) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []

  readonly url: string
  closed = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) ?? []
    current.push(listener)
    this.listeners.set(type, current)
  }

  removeEventListener(): void {}

  close(): void {
    this.closed = true
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) })
    }
  }
}

const sessionDetail: ApiSessionDetail = {
  id: "session_1",
  seq: 1,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  counts: {
    inputs: 0,
    pendingInputs: 0,
    turns: 0,
    items: 0,
    permissions: 0,
    tools: 0,
  },
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  useAppStore.setState(createInitialAppState())
  useAppStore.setState({ apiBase: "http://api.test" })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("app store event stream", () => {
  it("streams durable and transient events into the store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (String(input) === "http://api.test/sessions/session_1") {
          return jsonResponse({ session: sessionDetail })
        }
        return errorResponse(404)
      }),
    )

    await useAppStore.getState().selectSession("session_1")

    const source = FakeEventSource.instances[0]
    expect(source?.url).toBe(
      "http://api.test/sessions/session_1/events?after=0",
    )
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
    expect(useAppStore.getState().streamStatus).toBe("connecting")

    source?.emit("open")
    expect(useAppStore.getState().streamStatus).toBe("connected")

    const admitted = createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request:1",
          inputId: "input_1",
          role: InputRole.User,
          content: { kind: "text", text: "hello" },
        },
      },
    })
    source?.emit("session.event", admitted)
    await vi.waitFor(() => {
      expect(useAppStore.getState().events.map((event) => event.id)).toContain(
        admitted.id,
      )
    })

    source?.emit("session.transient", {
      type: "assistant.snapshot",
      sessionId: "session_1",
      turnId: "turn_1",
      streamId: "stream_1",
      text: "Hi there",
      createdAt: "2026-07-24T00:00:01.000Z",
    })
    const view = projectExecutionView(useAppStore.getState().execution)
    expect(view.entries).toEqual([
      expect.objectContaining({ kind: "user_input", text: "hello" }),
      expect.objectContaining({
        kind: "assistant",
        text: "Hi there",
        status: "streaming",
      }),
    ])

    source?.emit("error")
    expect(useAppStore.getState().streamStatus).toBe("disconnected")
  })

  it("ignores events from a stale stream after switching sessions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url === "http://api.test/sessions/session_a") {
          return jsonResponse({
            session: { ...sessionDetail, id: "session_a" },
          })
        }
        if (url === "http://api.test/sessions/session_b") {
          return jsonResponse({
            session: { ...sessionDetail, id: "session_b" },
          })
        }
        return errorResponse(404)
      }),
    )

    await useAppStore.getState().selectSession("session_a")
    await useAppStore.getState().selectSession("session_b")

    const stale = FakeEventSource.instances[0]
    const current = FakeEventSource.instances[1]
    expect(stale?.closed).toBe(true)
    expect(current?.url).toBe(
      "http://api.test/sessions/session_b/events?after=0",
    )

    stale?.emit("open")
    stale?.emit(
      "session.event",
      createEventEnvelope({
        sessionId: "session_a",
        seq: 1,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request:a",
            inputId: "input_a",
            role: InputRole.User,
            content: { kind: "text", text: "stale" },
          },
        },
      }),
    )

    expect(useAppStore.getState().events).toEqual([])
    expect(useAppStore.getState().selectedSession?.id).toBe("session_b")
    expect(useAppStore.getState().streamStatus).toBe("connecting")
  })
})

describe("cancel queued input", () => {
  it("posts the cancel route and clears the queue when input.cancelled flows", async () => {
    const cancelled = createEventEnvelope({
      sessionId: "session_1",
      seq: 3,
      event: {
        type: EventType.InputCancelled,
        data: { inputId: "input_1", reason: "user_cancel" },
      },
    })
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === "http://api.test/sessions/session_1") {
        return jsonResponse({ session: sessionDetail })
      }
      if (
        url === "http://api.test/sessions/session_1/inputs/input_1/cancel" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          sessionId: "session_1",
          inputId: "input_1",
          event: cancelled,
        })
      }
      return errorResponse(404)
    })
    vi.stubGlobal("fetch", fetchMock)

    await useAppStore.getState().selectSession("session_1")
    const source = FakeEventSource.instances[0]
    source?.emit(
      "session.event",
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request:1",
            inputId: "input_1",
            role: InputRole.User,
            content: { kind: "text", text: "hello" },
          },
        },
      }),
    )
    await vi.waitFor(() => {
      expect(
        projectExecutionView(useAppStore.getState().execution).queuedInputIds,
      ).toContain("input_1")
    })

    await useAppStore.getState().cancelQueuedInput("input_1")

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/sessions/session_1/inputs/input_1/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "user_cancel" }),
      }),
    )
    expect(useAppStore.getState().inFlightActions.size).toBe(0)
    // The recorded event from the response clears the row immediately.
    await vi.waitFor(() => {
      expect(
        projectExecutionView(useAppStore.getState().execution).queuedInputIds,
      ).not.toContain("input_1")
    })

    // The same fact streaming in later is deduplicated by event id.
    source?.emit("session.event", cancelled)
    await vi.waitFor(() => {
      const durableEvents = useAppStore.getState().execution.durableEvents
      expect(
        durableEvents.filter((event) => event.id === cancelled.id),
      ).toHaveLength(1)
    })
    expect(
      projectExecutionView(useAppStore.getState().execution).queuedInputIds,
    ).not.toContain("input_1")
  })

  it("treats 409 as a stale queue row: refreshes detail without an error banner", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === "http://api.test/sessions/session_1") {
        return jsonResponse({ session: sessionDetail })
      }
      if (
        url === "http://api.test/sessions/session_1/inputs/input_1/cancel" &&
        init?.method === "POST"
      ) {
        return conflictResponse()
      }
      return errorResponse(404)
    })
    vi.stubGlobal("fetch", fetchMock)

    await useAppStore.getState().selectSession("session_1")
    expect(detailCallCount(fetchMock)).toBe(1)

    await useAppStore.getState().cancelQueuedInput("input_1")

    expect(useAppStore.getState().message).toBeUndefined()
    expect(detailCallCount(fetchMock)).toBe(2)
    expect(useAppStore.getState().inFlightActions.size).toBe(0)
  })

  it("surfaces non-conflict failures through the message banner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        if (url === "http://api.test/sessions/session_1") {
          return jsonResponse({ session: sessionDetail })
        }
        if (
          url === "http://api.test/sessions/session_1/inputs/input_1/cancel" &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              error: { code: "internal_error", message: "boom" },
            }),
            { status: 500 },
          )
        }
        return errorResponse(404)
      }),
    )

    await useAppStore.getState().selectSession("session_1")
    await useAppStore.getState().cancelQueuedInput("input_1")

    expect(useAppStore.getState().message).toBe("boom")
  })
})

function detailCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(
    ([input]) => String(input) === "http://api.test/sessions/session_1",
  ).length
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function errorResponse(status: number): Response {
  return new Response(
    JSON.stringify({ error: { code: "not_found", message: "not found" } }),
    { status },
  )
}

function conflictResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "conflict",
        message: "Input input_1 is already started.",
      },
    }),
    { status: 409 },
  )
}
