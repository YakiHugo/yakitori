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

describe("delete session", () => {
  function summary(id: string) {
    return {
      id,
      seq: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    }
  }

  function stubDeleteFetch(sessionsAfterDelete: unknown[]) {
    return vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "DELETE") {
        return jsonResponse({ sessionId: url.split("/").at(-1) })
      }
      if (url === "http://api.test/sessions?limit=30") {
        return jsonResponse({ sessions: sessionsAfterDelete })
      }
      if (url === "http://api.test/sessions/session_1") {
        return jsonResponse({ session: sessionDetail })
      }
      return errorResponse(404)
    })
  }

  it("removes the session from state", async () => {
    const fetchMock = stubDeleteFetch([summary("session_2")])
    vi.stubGlobal("fetch", fetchMock)
    useAppStore.setState({
      sessions: [summary("session_1"), summary("session_2")],
    })

    await useAppStore.getState().deleteSession("session_1")

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/sessions/session_1",
      expect.objectContaining({ method: "DELETE" }),
    )
    expect(
      useAppStore.getState().sessions.map((session) => session.id),
    ).toEqual(["session_2"])
    expect(useAppStore.getState().inFlightActions.size).toBe(0)
  })

  it("clears the selection when the selected session is deleted", async () => {
    vi.stubGlobal("fetch", stubDeleteFetch([]))

    await useAppStore.getState().selectSession("session_1")
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
    const source = FakeEventSource.instances[0]

    await useAppStore.getState().deleteSession("session_1")

    expect(useAppStore.getState().selectedSession).toBeUndefined()
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    expect(useAppStore.getState().events).toEqual([])
    expect(useAppStore.getState().sessions).toEqual([])
    expect(source?.closed).toBe(true)
  })

  it("keeps the selection when another session is deleted", async () => {
    vi.stubGlobal("fetch", stubDeleteFetch([summary("session_1")]))

    await useAppStore.getState().selectSession("session_1")
    await useAppStore.getState().deleteSession("session_2")

    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
    expect(useAppStore.getState().selection.sessionId).toBe("session_1")
  })
})

describe("project state", () => {
  it("loads projects, falls back to the first project, and tolerates 404", async () => {
    window.localStorage.clear()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (String(input) === "http://api.test/projects") {
          return jsonResponse({ projects: ["/p/a", "/p/old"] })
        }
        return errorResponse(404)
      }),
    )

    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().projects).toEqual(["/p/a", "/p/old"])
    expect(useAppStore.getState().currentProject).toBe("/p/a")

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(404)),
    )
    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().projects).toEqual(["/p/a", "/p/old"])
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("prefers a remembered project that is still registered", async () => {
    window.localStorage.clear()
    window.localStorage.setItem("yakitori.project", "/p/old")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (String(input) === "http://api.test/projects") {
          return jsonResponse({ projects: ["/p/a", "/p/old"] })
        }
        return errorResponse(404)
      }),
    )

    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().currentProject).toBe("/p/old")
  })

  it("selectProject persists the choice and filters session loads", async () => {
    window.localStorage.clear()
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("http://api.test/sessions?")) {
        return jsonResponse({ sessions: [] })
      }
      return errorResponse(404)
    })
    vi.stubGlobal("fetch", fetchMock)
    useAppStore.setState({
      projects: ["/p/a", "/p/b"],
      currentProject: "/p/a",
    })

    await useAppStore.getState().selectProject("/p/b")

    expect(useAppStore.getState().currentProject).toBe("/p/b")
    expect(window.localStorage.getItem("yakitori.project")).toBe("/p/b")
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/sessions?limit=30&workingDirectory=%2Fp%2Fb",
      expect.objectContaining({ method: "GET" }),
    )
    expect(useAppStore.getState().sessions).toEqual([])
  })

  it("addProject updates the list and selects the resolved path", async () => {
    window.localStorage.clear()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        if (url === "http://api.test/projects" && init?.method === "POST") {
          return jsonResponse({ projects: ["/p/a", "/private/p/b"] })
        }
        if (url.startsWith("http://api.test/sessions?")) {
          return jsonResponse({ sessions: [] })
        }
        return errorResponse(404)
      }),
    )
    useAppStore.setState({ projects: ["/p/a"], currentProject: "/p/a" })

    await useAppStore.getState().addProject(" /p/b ")

    expect(useAppStore.getState().projects).toEqual(["/p/a", "/private/p/b"])
    expect(useAppStore.getState().currentProject).toBe("/private/p/b")
  })

  it("createSession sends the current project as workingDirectory", async () => {
    window.localStorage.clear()
    const created = createEventEnvelope({
      sessionId: "session_1",
      seq: 1,
      event: { type: EventType.SessionCreated, data: {} },
    })
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === "http://api.test/sessions" && init?.method === "POST") {
        return jsonResponse({ session: sessionDetail, event: created })
      }
      if (url.startsWith("http://api.test/sessions?")) {
        return jsonResponse({ sessions: [sessionDetail] })
      }
      return errorResponse(404)
    })
    vi.stubGlobal("fetch", fetchMock)
    useAppStore.setState({ projects: ["/p/a"], currentProject: "/p/a" })

    await useAppStore.getState().createSession()

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/sessions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"workingDirectory":"/p/a"'),
      }),
    )
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
  })
})

describe("model selection", () => {
  it("persists selections per session and rehydrates from localStorage", () => {
    window.localStorage.clear()

    useAppStore.getState().setModelSelection("session_1", {
      provider: "openai",
      model: "gpt-5.1-codex",
      effort: "high",
    })
    useAppStore
      .getState()
      .setModelSelection("session_2", { provider: "kimi", model: "k2" })

    const expected = {
      session_1: { provider: "openai", model: "gpt-5.1-codex", effort: "high" },
      session_2: { provider: "kimi", model: "k2" },
    }
    expect(useAppStore.getState().modelSelections).toEqual(expected)
    expect(
      JSON.parse(
        window.localStorage.getItem("yakitori.modelSelections") ?? "{}",
      ),
    ).toEqual(expected)
    expect(createInitialAppState().modelSelections).toEqual(expected)

    useAppStore.getState().setModelSelection("session_1", undefined)
    expect(useAppStore.getState().modelSelections).toEqual({
      session_2: { provider: "kimi", model: "k2" },
    })
  })

  it("loads providers and tolerates a 404 from older servers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (String(input) === "http://api.test/providers") {
          return jsonResponse({
            providers: [
              {
                name: "faux",
                defaultModel: "scripted",
                models: [
                  {
                    id: "scripted",
                    displayName: "scripted",
                    family: "default",
                  },
                ],
              },
              {
                name: "anthropic",
                models: [
                  {
                    id: "claude-sonnet-4-6",
                    displayName: "Claude Sonnet 4.6",
                    family: "anthropic",
                  },
                ],
              },
            ],
            defaultProvider: "faux",
            defaultModel: "scripted",
          })
        }
        return errorResponse(404)
      }),
    )

    await useAppStore.getState().loadProviders()

    expect(useAppStore.getState().providers).toEqual([
      {
        name: "faux",
        defaultModel: "scripted",
        models: [
          { id: "scripted", displayName: "scripted", family: "default" },
        ],
      },
      {
        name: "anthropic",
        models: [
          {
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            family: "anthropic",
          },
        ],
      },
    ])
    expect(useAppStore.getState().defaultProvider).toBe("faux")
    expect(useAppStore.getState().defaultModel).toBe("scripted")

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(404)),
    )
    await useAppStore.getState().loadProviders()

    expect(useAppStore.getState().providers).toHaveLength(2)
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("sends the saved modelSelection with admitted input", async () => {
    window.localStorage.clear()
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === "http://api.test/sessions/session_1/inputs") {
        const body = JSON.parse(String(init?.body)) as { requestId: string }
        return jsonResponse({
          requestId: body.requestId,
          inputId: "input_1",
          event: createEventEnvelope({
            sessionId: "session_1",
            seq: 2,
            event: {
              type: EventType.InputAdmitted,
              data: {
                requestId: body.requestId,
                inputId: "input_1",
                role: InputRole.User,
                content: { kind: "text", text: "hello" },
              },
            },
          }),
        })
      }
      if (url === "http://api.test/sessions/session_1") {
        return jsonResponse({ session: sessionDetail })
      }
      if (url.startsWith("http://api.test/sessions?")) {
        return jsonResponse({ sessions: [] })
      }
      return errorResponse(404)
    })
    vi.stubGlobal("fetch", fetchMock)
    useAppStore.setState({
      selection: { revision: 1, sessionId: "session_1" },
      modelSelections: {
        session_1: {
          provider: "openai",
          model: "gpt-5.1-codex",
          effort: "low",
        },
      },
    })

    await useAppStore.getState().admitInput("hello")

    const admitCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/inputs"),
    )
    expect(admitCall).toBeDefined()
    expect(JSON.parse(String(admitCall?.[1]?.body))).toMatchObject({
      content: { kind: "text", text: "hello" },
      modelSelection: {
        provider: "openai",
        model: "gpt-5.1-codex",
        effort: "low",
      },
    })
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("omits modelSelection when no override is saved", async () => {
    window.localStorage.clear()
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === "http://api.test/sessions/session_1/inputs") {
        const body = JSON.parse(String(init?.body)) as { requestId: string }
        return jsonResponse({
          requestId: body.requestId,
          inputId: "input_1",
          event: createEventEnvelope({
            sessionId: "session_1",
            seq: 2,
            event: {
              type: EventType.InputAdmitted,
              data: {
                requestId: body.requestId,
                inputId: "input_1",
                role: InputRole.User,
                content: { kind: "text", text: "hello" },
              },
            },
          }),
        })
      }
      if (url === "http://api.test/sessions/session_1") {
        return jsonResponse({ session: sessionDetail })
      }
      if (url.startsWith("http://api.test/sessions?")) {
        return jsonResponse({ sessions: [] })
      }
      return errorResponse(404)
    })
    vi.stubGlobal("fetch", fetchMock)
    useAppStore.setState({
      selection: { revision: 1, sessionId: "session_1" },
    })

    await useAppStore.getState().admitInput("hello")

    const admitCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/inputs"),
    )
    expect(JSON.parse(String(admitCall?.[1]?.body))).not.toHaveProperty(
      "modelSelection",
    )
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
