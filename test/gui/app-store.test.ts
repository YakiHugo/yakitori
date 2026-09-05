// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectExecutionView } from "../../src/gui/execution-view.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import {
  createInitialAppState,
  normalizeKimiModelSelection,
  resolveEffectiveModel,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  createEventEnvelope,
  EventType,
  InputRole,
} from "../../src/kernel/events.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"
import { FakeRpcClient, type FakeSessionStream } from "./fake-rpc-client.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))

vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/gui/lib/rpc-client.ts")
    >()
  return {
    ...original,
    getAppRpcClient: () => fakeRef.current,
  }
})

const sessionDetail: ApiSessionDetail = {
  id: "session_1",
  conversationId: "conversation_1",
  seq: 1,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  pendingInputs: [],
  pendingPermissions: [],
  counts: {
    inputs: 0,
    pendingInputs: 0,
    turns: 0,
    items: 0,
    permissions: 0,
    tools: 0,
  },
}

function emitSnapshot(
  stream: FakeSessionStream | undefined,
  session: ApiSessionDetail = sessionDetail,
): void {
  stream?.emitSnapshot({ session })
}

function notFound(): never {
  throw new ApiRequestError("not found", "not_found")
}

beforeEach(() => {
  fakeRef.current = new FakeRpcClient()
  useAppStore.setState(createInitialAppState())
  useAppStore.setState({ apiBase: "http://api.test" })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("app store event stream", () => {
  it("streams durable execution events into the store", async () => {
    useAppStore.setState({ sessions: [sessionDetail] })
    await useAppStore.getState().selectSession("session_1")

    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream)
    expect(fakeRef.current.requests).toEqual([])
    expect(stream?.sessionId).toBe("session_1")
    expect(stream?.after).toBe(0)
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
    expect(useAppStore.getState().restoringModelSelectionFor).toBe("session_1")

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
    stream?.emitEvent(admitted)
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([expect.objectContaining({ kind: "user_input", text: "hello" })])
    expect(useAppStore.getState().selectedSession?.counts).toMatchObject({
      inputs: 1,
      pendingInputs: 1,
      turns: 0,
    })
    stream?.emitReplayComplete()
    expect(useAppStore.getState().restoringModelSelectionFor).toBeUndefined()

    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 3,
        event: {
          type: EventType.TurnStarted,
          data: { turnId: "turn_1", inputId: "input_1" },
        },
      }),
    )
    stream?.emitTransient({
      type: "item.started",
      sessionId: "session_1",
      turnId: "turn_1",
      item: { type: "agent_message", itemId: "item_1" },
      createdAt: "2026-07-24T00:00:00.000Z",
    })
    stream?.emitTransient({
      type: "assistant.delta",
      sessionId: "session_1",
      turnId: "turn_1",
      itemId: "item_1",
      delta: "Hi there",
      createdAt: "2026-07-24T00:00:00.000Z",
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
    expect(useAppStore.getState().selectedSession?.counts).toMatchObject({
      inputs: 1,
      pendingInputs: 0,
      turns: 1,
      items: 0,
    })
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 4,
        event: {
          type: EventType.ItemCompleted,
          data: {
            turnId: "turn_1",
            item: {
              type: "agent_message",
              itemId: "item_1",
              content: [{ type: "text", text: "Hi there" }],
            },
          },
        },
      }),
    )
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 5,
        event: {
          type: EventType.ItemCompleted,
          data: {
            turnId: "turn_1",
            item: {
              type: "dynamic_tool_call",
              itemId: "item_2",
              toolCallId: "tool_1",
              name: "tool",
              input: {},
              requiresPermission: false,
              resultItemId: "result_1",
              content: { kind: "text", text: "done" },
            },
          },
        },
      }),
    )
    expect(useAppStore.getState().selectedSession?.counts).toMatchObject({
      items: 2,
      tools: 1,
    })
    expect(useAppStore.getState().sessions[0]?.seq).toBe(5)
  })

  it("does not revive a permission resolved before its answer failure returns", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, {
      ...sessionDetail,
      activeTurnId: "turn_1",
      pendingPermissions: [
        {
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "call_1",
          action: "run_command",
          createdAt: "2026-07-24T00:00:00.000Z",
        },
      ],
      counts: { ...sessionDetail.counts, permissions: 1 },
    })

    fakeRef.current.answerError = new Error("answer lost")
    const resolving = useAppStore
      .getState()
      .resolvePermission("turn_1", "permission_1", "allow")
    stream?.emitTransient({
      type: "permission.resolved",
      sessionId: "session_1",
      turnId: "turn_1",
      permissionRequestId: "permission_1",
      outcome: "allow",
      createdAt: "2026-07-24T00:00:01.000Z",
    })
    await resolving

    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([
      expect.objectContaining({
        kind: "permission",
        permissionRequestId: "permission_1",
        state: "resolved",
        behavior: "allow",
      }),
    ])
    expect(useAppStore.getState().selectedSession?.counts.permissions).toBe(0)
  })

  it("answers the pending server request when resolving a permission", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, {
      ...sessionDetail,
      activeTurnId: "turn_1",
      pendingPermissions: [
        {
          permissionRequestId: "permission_1",
          turnId: "turn_1",
          toolCallId: "call_1",
          action: "run_command",
          createdAt: "2026-07-24T00:00:00.000Z",
        },
      ],
      counts: { ...sessionDetail.counts, permissions: 1 },
    })

    await useAppStore
      .getState()
      .resolvePermission("turn_1", "permission_1", "deny")

    expect(fakeRef.current.answeredPermissions).toEqual([
      {
        permissionRequestId: "permission_1",
        result: { behavior: "deny", reason: { kind: "user_denied" } },
      },
    ])
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("ignores events from a stale stream after switching sessions", async () => {
    await useAppStore.getState().selectSession("session_a")
    await useAppStore.getState().selectSession("session_b")

    const stale = fakeRef.current.streams[0]
    const current = fakeRef.current.streams[1]
    emitSnapshot(current, { ...sessionDetail, id: "session_b" })
    expect(stale?.closed).toBe(true)
    expect(current?.sessionId).toBe("session_b")
    expect(current?.after).toBe(0)

    stale?.emitEvent(
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

    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([])
    expect(useAppStore.getState().selectedSession?.id).toBe("session_b")
  })
})

describe("cancel queued input", () => {
  it("sends the cancel method and clears the queue when input.cancelled flows", async () => {
    const cancelled = createEventEnvelope({
      sessionId: "session_1",
      seq: 3,
      event: {
        type: EventType.InputCancelled,
        data: { inputId: "input_1", reason: "user_cancel" },
      },
    })
    fakeRef.current.respond = (method) => {
      if (method === "session/input/cancel") {
        return { sessionId: "session_1", inputId: "input_1", event: cancelled }
      }
      return notFound()
    }

    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream)
    stream?.emitEvent(
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

    expect(fakeRef.current.requests).toContainEqual({
      method: "session/input/cancel",
      params: {
        sessionId: "session_1",
        inputId: "input_1",
        reason: "user_cancel",
      },
    })
    expect(useAppStore.getState().inFlightActions.size).toBe(0)
    expect(
      projectExecutionView(useAppStore.getState().execution).queuedInputIds,
    ).toContain("input_1")

    // The ordered stream owns the queue transition.
    stream?.emitEvent(cancelled)
    expect(
      projectExecutionView(useAppStore.getState().execution).queuedInputIds,
    ).not.toContain("input_1")
  })

  it("treats a conflict as a stale queue row: no error banner", async () => {
    fakeRef.current.respond = (method) => {
      if (method === "session/input/cancel") {
        throw new ApiRequestError(
          "Input input_1 is already started.",
          "conflict",
        )
      }
      return notFound()
    }

    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])

    await useAppStore.getState().cancelQueuedInput("input_1")

    expect(useAppStore.getState().message).toBeUndefined()
    expect(useAppStore.getState().inFlightActions.size).toBe(0)
  })

  it("surfaces non-conflict failures through the message banner", async () => {
    fakeRef.current.respond = (method) => {
      if (method === "session/input/cancel") {
        throw new ApiRequestError("boom", "internal_error")
      }
      return notFound()
    }

    await useAppStore.getState().selectSession("session_1")
    await useAppStore.getState().cancelQueuedInput("input_1")

    expect(useAppStore.getState().message).toBe("boom")
  })
})

describe("delete session", () => {
  function summary(id: string) {
    return {
      id,
      conversationId: `conversation_${id}`,
      seq: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    }
  }

  function respondToDelete(sessionsAfterDelete: unknown[]) {
    return (method: string, params: unknown) => {
      if (method === "session/delete") {
        return { sessionId: (params as { sessionId: string }).sessionId }
      }
      if (method === "session/list") {
        return { sessions: sessionsAfterDelete }
      }
      return notFound()
    }
  }

  it("removes the session from state", async () => {
    fakeRef.current.respond = respondToDelete([summary("session_2")])
    useAppStore.setState({
      sessions: [summary("session_1"), summary("session_2")],
    })

    await useAppStore.getState().deleteSession("session_1")

    expect(fakeRef.current.requests).toContainEqual({
      method: "session/delete",
      params: { sessionId: "session_1" },
    })
    expect(
      useAppStore.getState().sessions.map((session) => session.id),
    ).toEqual(["session_2"])
    expect(useAppStore.getState().inFlightActions.size).toBe(0)
  })

  it("clears the selection when the selected session is deleted", async () => {
    fakeRef.current.respond = respondToDelete([])

    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
    const stream = fakeRef.current.streams[0]

    await useAppStore.getState().deleteSession("session_1")

    expect(useAppStore.getState().selectedSession).toBeUndefined()
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([])
    expect(useAppStore.getState().sessions).toEqual([])
    expect(stream?.closed).toBe(true)
  })

  it("keeps the selection when another session is deleted", async () => {
    fakeRef.current.respond = respondToDelete([summary("session_1")])

    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])
    await useAppStore.getState().deleteSession("session_2")

    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
    expect(useAppStore.getState().selection.sessionId).toBe("session_1")
  })
})

describe("fork session", () => {
  it("edits through one fork request and selects the new Session", async () => {
    window.localStorage.clear()
    const activeSession: ApiSessionDetail = {
      ...sessionDetail,
      seq: 3,
      activeTurnId: "turn_1",
      counts: { ...sessionDetail.counts, inputs: 1, turns: 1 },
    }
    const forkedSession: ApiSessionDetail = {
      ...sessionDetail,
      id: "session_fork",
      seq: 2,
      parentSessionId: "session_1",
      forkedFromInputId: "input_1",
      forkReason: "edit",
      counts: { ...sessionDetail.counts, inputs: 1 },
    }
    const forkEvents = [
      createEventEnvelope({
        sessionId: "session_fork",
        seq: 1,
        event: {
          type: EventType.SessionCreated,
          data: {
            parentSessionId: "session_1",
            forkedFromInputId: "input_1",
            forkReason: "edit",
          },
        },
      }),
      createEventEnvelope({
        sessionId: "session_fork",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request:replacement",
            inputId: "input_replacement",
            role: InputRole.User,
            content: { kind: "text", text: "replacement" },
            parentInputId: "input_1",
            modelSelection: {
              provider: "openai",
              model: "gpt-test",
              effort: "high",
            },
          },
        },
      }),
    ]
    fakeRef.current.respond = (method) => {
      if (method === "session/fork") {
        return {
          session: forkedSession,
          historyEndSeqExclusive: 2,
          events: forkEvents,
        }
      }
      if (method === "session/list") {
        return { sessions: [forkedSession, activeSession] }
      }
      return notFound()
    }
    useAppStore.setState({
      modelSelections: {
        session_1: { provider: "openai", model: "gpt-test", effort: "high" },
      },
    })

    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, activeSession)
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request:fork",
            inputId: "input_1",
            role: InputRole.User,
            content: { kind: "text", text: "original" },
          },
        },
      }),
    )
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 3,
        event: {
          type: EventType.TurnStarted,
          data: { turnId: "turn_1", inputId: "input_1" },
        },
      }),
    )

    await useAppStore.getState().forkSession("input_1", "edit", "replacement")

    expect(fakeRef.current.requestsFor("session/input/cancel")).toEqual([])
    expect(fakeRef.current.requestsFor("session/fork")).toEqual([
      {
        method: "session/fork",
        params: {
          sessionId: "session_1",
          atInputId: "input_1",
          reason: "edit",
          content: { kind: "text", text: "replacement" },
          modelSelection: {
            provider: "openai",
            model: "gpt-test",
            effort: "high",
          },
        },
      },
    ])
    expect(useAppStore.getState().selectedSession).toEqual(forkedSession)
    expect(useAppStore.getState().selection.sessionId).toBe("session_fork")
    expect(useAppStore.getState().modelSelections.session_fork).toEqual({
      provider: "openai",
      model: "gpt-test",
      effort: "high",
    })
    expect(useAppStore.getState().composerFocusRevision).toBe(1)
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([
      expect.objectContaining({
        kind: "user_input",
        inputId: "input_replacement",
        text: "replacement",
      }),
    ])
    expect(stream?.closed).toBe(true)
    const forkStream = fakeRef.current.streams[1]
    expect(forkStream?.sessionId).toBe("session_fork")
    expect(forkStream?.after).toBe(2)
  })
})

describe("project state", () => {
  it("loads projects, falls back to the first project, and tolerates failures", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = (method) => {
      if (method === "project/list") {
        return { projects: ["/p/a", "/p/old"] }
      }
      return notFound()
    }

    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().projects).toEqual(["/p/a", "/p/old"])
    expect(useAppStore.getState().currentProject).toBe("/p/a")

    fakeRef.current.respond = () => notFound()
    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().projects).toEqual(["/p/a", "/p/old"])
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("prefers a remembered project that is still registered", async () => {
    window.localStorage.clear()
    window.localStorage.setItem("yakitori.project", "/p/old")
    fakeRef.current.respond = (method) => {
      if (method === "project/list") {
        return { projects: ["/p/a", "/p/old"] }
      }
      return notFound()
    }

    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().currentProject).toBe("/p/old")
  })

  it("selectProject persists the choice and filters session loads", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = (method) => {
      if (method === "session/list") {
        return { sessions: [] }
      }
      return notFound()
    }
    useAppStore.setState({
      projects: ["/p/a", "/p/b"],
      currentProject: "/p/a",
    })

    await useAppStore.getState().selectProject("/p/b")

    expect(useAppStore.getState().currentProject).toBe("/p/b")
    expect(window.localStorage.getItem("yakitori.project")).toBe("/p/b")
    expect(fakeRef.current.requestsFor("session/list")).toEqual([
      {
        method: "session/list",
        params: { limit: 30, workingDirectory: "/p/b" },
      },
    ])
    expect(useAppStore.getState().sessions).toEqual([])
  })

  it("keeps the latest same-project session list response", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined
    let resolveSecond: ((value: unknown) => void) | undefined
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise((resolve) => {
      resolveSecond = resolve
    })
    let requestCount = 0
    fakeRef.current.respond = (method) => {
      if (method !== "session/list") return notFound()
      requestCount += 1
      return requestCount === 1 ? first : second
    }
    useAppStore.setState({ currentProject: "/p/a" })

    const slow = useAppStore.getState().loadSessions()
    const fast = useAppStore.getState().loadSessions()
    resolveSecond?.({
      sessions: [{ ...sessionDetail, id: "session_new" }],
    })
    await fast
    resolveFirst?.({
      sessions: [{ ...sessionDetail, id: "session_old" }],
    })
    await slow

    expect(
      useAppStore.getState().sessions.map((session) => session.id),
    ).toEqual(["session_new"])
  })

  it("addProject updates the list and selects the resolved path", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = (method) => {
      if (method === "project/add") {
        return { projects: ["/p/a", "/private/p/b"] }
      }
      if (method === "session/list") {
        return { sessions: [] }
      }
      return notFound()
    }
    useAppStore.setState({ projects: ["/p/a"], currentProject: "/p/a" })

    await useAppStore.getState().addProject(" /p/b ")

    expect(fakeRef.current.requestsFor("project/add")).toEqual([
      { method: "project/add", params: { path: "/p/b" } },
    ])
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
    fakeRef.current.respond = (method) => {
      if (method === "session/create") {
        return { session: sessionDetail, event: created }
      }
      if (method === "session/list") {
        return { sessions: [sessionDetail] }
      }
      return notFound()
    }
    useAppStore.setState({ projects: ["/p/a"], currentProject: "/p/a" })

    await useAppStore.getState().createSession()

    expect(fakeRef.current.requestsFor("session/create")).toEqual([
      {
        method: "session/create",
        params: {
          title: expect.stringContaining("Session"),
          workingDirectory: "/p/a",
        },
      },
    ])
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
  })
})

describe("model selection", () => {
  it("drops obsolete boolean thinking values from K2.7 selections", () => {
    expect(
      normalizeKimiModelSelection(
        {
          provider: "kimi",
          model: "kimi-for-coding-highspeed",
          effort: "off",
        },
        [
          {
            name: "kimi",
            models: [
              {
                id: "kimi-for-coding-highspeed",
                instructionProfileId: "kimi",
                effortStyle: "none",
              },
            ],
          },
        ],
      ),
    ).toEqual({ provider: "kimi", model: "kimi-for-coding-highspeed" })
    expect(
      normalizeKimiModelSelection(
        {
          provider: "kimi",
          model: "k3",
          effort: "max",
        },
        [
          {
            name: "kimi",
            models: [
              {
                id: "k3",
                instructionProfileId: "kimi",
                effortStyle: "levels",
              },
            ],
          },
        ],
      ),
    ).toEqual({ provider: "kimi", model: "k3", effort: "max" })
  })

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

  it("loads providers and tolerates a failure from the server", async () => {
    fakeRef.current.respond = (method) => {
      if (method === "provider/list") {
        return {
          providers: [
            {
              name: "faux",
              defaultModel: "scripted",
              models: [
                {
                  id: "scripted",
                  displayName: "scripted",
                  instructionProfileId: "default",
                },
              ],
            },
            {
              name: "anthropic",
              models: [
                {
                  id: "claude-sonnet-4-6",
                  displayName: "Claude Sonnet 4.6",
                  instructionProfileId: "anthropic",
                },
              ],
            },
          ],
          defaultProvider: "faux",
          defaultModel: "scripted",
          userPreference: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            effort: "high",
          },
        }
      }
      return notFound()
    }

    await useAppStore.getState().loadProviders()

    expect(useAppStore.getState().providers).toEqual([
      {
        name: "faux",
        defaultModel: "scripted",
        models: [
          {
            id: "scripted",
            displayName: "scripted",
            instructionProfileId: "default",
          },
        ],
      },
      {
        name: "anthropic",
        models: [
          {
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            instructionProfileId: "anthropic",
          },
        ],
      },
    ])
    expect(useAppStore.getState().defaultProvider).toBe("faux")
    expect(useAppStore.getState().defaultModel).toBe("scripted")
    expect(useAppStore.getState().userPreference).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      effort: "high",
    })

    fakeRef.current.respond = () => notFound()
    await useAppStore.getState().loadProviders()

    expect(useAppStore.getState().providers).toHaveLength(2)
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("sends the saved modelSelection with admitted input", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      modelSelections: {
        session_1: {
          provider: "openai",
          model: "gpt-5.1-codex",
          effort: "low",
        },
      },
    })

    await useAppStore.getState().admitInput("hello")

    const admissions = fakeRef.current.requestsFor("session/input")
    expect(admissions).toHaveLength(1)
    expect(admissions[0]?.params).toMatchObject({
      sessionId: "session_1",
      content: { kind: "text", text: "hello" },
      modelSelection: {
        provider: "openai",
        model: "gpt-5.1-codex",
        effort: "low",
      },
    })
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("clears an attachment-only draft after admission", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    const attachment = {
      name: "screen.png",
      mediaType: "image/png" as const,
      detail: "high" as const,
      sizeBytes: 9,
      file: {
        rolloutId: "session_1",
        path: "attachments/staging/draft_1/1.png",
      },
    }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptAttachments: [attachment],
    })

    await useAppStore.getState().admitInput("", [attachment])

    expect(useAppStore.getState().promptAttachments).toEqual([])
  })

  it("uses a picker choice immediately for the pill, admission, and user preference", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-sol",
      modelSelections: {
        session_1: {
          provider: "openai",
          model: "gpt-5.6-sol",
          effort: "high",
        },
      },
    })

    const picked = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      effort: "low",
    }
    useAppStore.getState().setModelSelection("session_1", picked)

    expect(
      resolveEffectiveModel({
        sessionCurrent: useAppStore.getState().modelSelections.session_1,
        userPreference: useAppStore.getState().userPreference,
        defaultProvider: "openai",
        defaultModel: "gpt-5.6-sol",
      }),
    ).toEqual(picked)

    await useAppStore.getState().admitInput("hello")

    const params = fakeRef.current.requests.map((request) => request.params)
    expect(params).toContainEqual(picked)
    expect(params).toContainEqual(
      expect.objectContaining({ modelSelection: picked }),
    )
  })

  it("restores old session current from its last turn without leaking across sessions", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = () => notFound()
    useAppStore.setState({
      modelSelections: {},
      userPreference: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      defaultProvider: "faux",
      defaultModel: "scripted",
    })

    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0], {
      ...sessionDetail,
      currentModel: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    })
    await vi.waitFor(() => {
      expect(useAppStore.getState().modelSelections.session_1).toEqual({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      })
    })
    useAppStore.setState({
      userPreference: { provider: "faux", model: "new-global-default" },
    })

    const state = useAppStore.getState()
    expect(
      resolveEffectiveModel({
        sessionCurrent: state.modelSelections.session_1,
        userPreference: state.userPreference,
        defaultProvider: state.defaultProvider,
        defaultModel: state.defaultModel,
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    })
    expect(
      resolveEffectiveModel({
        sessionCurrent: state.modelSelections.session_2,
        userPreference: state.userPreference,
        defaultProvider: state.defaultProvider,
        defaultModel: state.defaultModel,
      }),
    ).toEqual({ provider: "faux", model: "new-global-default" })
    expect(
      JSON.parse(
        window.localStorage.getItem("yakitori.modelSelections") ?? "{}",
      ),
    ).toMatchObject({
      session_1: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    })
  })

  it("restores the Session model before admitting its next input", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({
      modelSelections: {},
      userPreference: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    })

    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0], {
      ...sessionDetail,
      currentModel: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    })
    await useAppStore.getState().admitInput("restored")

    const admissions = fakeRef.current.requestsFor("session/input")
    expect(admissions[0]?.params).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    })
  })

  it("keeps a failed preference write scoped to the current Session", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = () => notFound()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      userPreference: { provider: "faux", model: "scripted" },
      modelSelections: {},
    })

    useAppStore.getState().setModelSelection("session_1", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    })

    await vi.waitFor(() => {
      expect(useAppStore.getState().message).toBe("not found")
    })
    expect(useAppStore.getState().modelSelections.session_1).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    })
    expect(useAppStore.getState().userPreference).toEqual({
      provider: "faux",
      model: "scripted",
    })
  })

  it("unlocks admission when the user picks a model during restoration", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({ modelSelections: {} })

    await useAppStore.getState().selectSession("session_1")
    expect(useAppStore.getState().restoringModelSelectionFor).toBe("session_1")

    useAppStore.getState().setModelSelection("session_1", {
      provider: "codex",
      model: "gpt-5.6-sol",
    })

    expect(useAppStore.getState().restoringModelSelectionFor).toBeUndefined()
  })

  it("ignores a stale preference write failure after a newer choice", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    fakeRef.current.respond = (method, params) => {
      if (method !== "userPreference/write") return notFound()
      if ((params as { model: string }).model === "first") return first
      return { userPreference: params }
    }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      modelSelections: {},
    })

    useAppStore.getState().setModelSelection("session_1", {
      provider: "faux",
      model: "first",
    })
    useAppStore.getState().setModelSelection("session_1", {
      provider: "faux",
      model: "second",
    })
    await vi.waitFor(() => {
      expect(useAppStore.getState().userPreference).toEqual({
        provider: "faux",
        model: "second",
      })
    })
    resolveFirst?.(Promise.reject(new ApiRequestError("write failed")))
    await vi.waitFor(() => {
      expect(useAppStore.getState().busy).toBe(false)
    })

    expect(useAppStore.getState().message).toBeUndefined()
    expect(useAppStore.getState().userPreference).toEqual({
      provider: "faux",
      model: "second",
    })
  })

  it("stamps the user preference on a new session's first input", async () => {
    window.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      modelSelections: {},
      defaultProvider: "faux",
      defaultModel: "scripted",
      userPreference: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "high",
      },
    })

    await useAppStore.getState().admitInput("hello")

    const admissions = fakeRef.current.requestsFor("session/input")
    expect(admissions[0]?.params).toMatchObject({
      modelSelection: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "high",
      },
    })
  })
})

function admissionResponder() {
  return (method: string, params: unknown) => {
    if (method === "userPreference/write") {
      return { userPreference: params }
    }
    if (method === "session/input") {
      const body = params as { requestId: string }
      return {
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
      }
    }
    if (method === "session/list") {
      return { sessions: [] }
    }
    return notFound()
  }
}
