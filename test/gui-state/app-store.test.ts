import { inputFixture } from "../fixtures/user-input.ts"
import "./setup-store-environment.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ThreadGoal } from "../../src/core/goal.ts"
import {
  createExecutionViewState,
  projectExecutionView,
} from "../../src/gui/execution-view.ts"
import { inputRecoveryMemory } from "../../src/gui/input-recovery-memory.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import {
  createInitialAppState,
  resolveEffectiveModel,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import {
  clearThreadScopes,
  readThreadScopeValue,
  writeThreadScopeValue,
} from "../../src/gui/store/thread-scope-store.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"
import {
  createEventEnvelope,
  EventType,
  type InputContent,
  InputRole,
} from "../../src/kernel/events.ts"
import type {
  ApiProject,
  ApiProviderSummary,
  ApiSessionDetail,
} from "../../src/server/protocol.ts"
import {
  FakeRpcClient,
  type FakeSessionStream,
} from "../gui/fake-rpc-client.ts"
import { inputParts } from "../gui/input-fixtures.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))

vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()
  return {
    ...original,
    getAppRpcClient: () => fakeRef.current,
  }
})

const sessionDetail: ApiSessionDetail = {
  id: "session_1",
  rolloutId: "rollout_original",
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

function deferredResponse() {
  let resolve!: (value: unknown) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeProject(id: string, root: string, name = ""): ApiProject {
  return {
    id,
    name,
    roots: [root],
    metadata: {},
    position: 0,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

beforeEach(() => {
  globalThis.localStorage.clear()
  inputRecoveryMemory.clear()
  clearThreadScopes()
  fakeRef.current = new FakeRpcClient()
  useAppStore.setState(
    { ...useAppStore.getInitialState(), ...createInitialAppState() },
    true,
  )
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
  useAppStore.setState({ apiBase: "http://api.test" })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("partial conversation history", () => {
  it("opens ordinary sessions with recent history", async () => {
    await useAppStore.getState().selectSession("session_1")
    expect(fakeRef.current.streams[0]?.options?.recent).toBe(true)
  })

  it("preserves unloaded history across an incremental reconnect snapshot", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    stream?.emitSnapshot({
      session: { ...sessionDetail, seq: 20 },
      historyBefore: 10,
    })
    stream?.emitReplayComplete()
    stream?.disconnect(new Error("Disconnected"))
    emitSnapshot(stream, { ...sessionDetail, seq: 21 })
    stream?.emitReplayComplete()
    expect(useAppStore.getState().historyBefore).toBe(10)
  })

  it("checks complete history before restoring an unconfirmed input", async () => {
    const content = inputFixture(inputParts("already accepted"))
    const pending = inputRecoveryMemory.reserveAdmission({
      apiBase: useAppStore.getState().apiBase,
      sessionId: "session_1",
      content,
    })
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    expect(stream?.options?.recent).toBe(false)
    emitSnapshot(stream, { ...sessionDetail, seq: 100 })
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: pending.requestId,
            inputId: "input_old",
            role: InputRole.User,
            content,
          },
        },
      }),
    )
    stream?.emitReplayComplete()
    await vi.waitFor(() =>
      expect(
        inputRecoveryMemory.listAdmissionsForSession(
          useAppStore.getState().apiBase,
          "session_1",
        ),
      ).toEqual([]),
    )
    expect(useAppStore.getState().promptDraft).toBeUndefined()
  })

  it.each([
    "human",
    "agent",
  ] as const)("loads earlier pages until a requested %s message is available", async (source) => {
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      historyBefore: 10,
      execution: { ...createExecutionViewState(), lastSeq: 100 },
    })
    fakeRef.current.respond = (method, params) => {
      if (method !== "session/history") return notFound()
      const before = (params as { before: number }).before
      return {
        events: [
          createEventEnvelope({
            sessionId: "session_1",
            seq: before === 10 ? 8 : 2,
            event: {
              type: EventType.InputAdmitted,
              data: {
                requestId: before === 10 ? "request_middle" : "request_old",
                inputId: before === 10 ? "input_middle" : "input_old",
                role: source === "human" ? InputRole.User : InputRole.Runtime,
                source,
                content: inputFixture(
                  inputParts(before === 10 ? "middle" : "old"),
                ),
              },
            },
          }),
        ],
        ...(before === 10 ? { historyBefore: 5 } : {}),
      }
    }
    expect(await useAppStore.getState().loadHistoryThrough("input_old")).toBe(
      true,
    )
    expect(fakeRef.current.requestsFor("session/history")).toEqual([
      {
        method: "session/history",
        params: { sessionId: "session_1", before: 10 },
      },
      {
        method: "session/history",
        params: { sessionId: "session_1", before: 5 },
      },
    ])
    expect(useAppStore.getState().execution.lastSeq).toBe(100)
    expect(
      useAppStore
        .getState()
        .execution.entries.map((entry) =>
          entry.kind === "user_input" || entry.kind === "agent_input"
            ? entry.text
            : entry.kind,
        ),
    ).toEqual(["old", "middle"])
  })

  it("discards an earlier page after leaving and returning to the session", async () => {
    const page = deferredResponse()
    fakeRef.current.respond = () => page.promise
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      sessionSelectionIntentRevision: 1,
      historyBefore: 10,
    })
    const beforePrepend = vi.fn()
    const loading = useAppStore.getState().loadEarlierHistory({ beforePrepend })
    useAppStore.setState({ sessionSelectionIntentRevision: 3 })
    page.resolve({ events: [], historyBefore: 5 })
    expect(await loading).toBe(false)
    expect(beforePrepend).not.toHaveBeenCalled()
    expect(useAppStore.getState().historyBefore).toBe(10)
  })

  it("stops targeted history loading when the server repeats its cursor", async () => {
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      historyBefore: 10,
    })
    fakeRef.current.respond = () => ({ events: [], historyBefore: 10 })
    expect(
      await useAppStore.getState().loadHistoryThrough("input_missing"),
    ).toBe(false)
    expect(fakeRef.current.requestsFor("session/history")).toHaveLength(1)
    expect(useAppStore.getState().message).toBe(
      "Earlier history did not advance.",
    )
  })
})

describe("app store initialization", () => {
  it.each([
    "{broken",
    "null",
    "[]",
    '"invalid"',
    "42",
  ])("starts with expanded sections when the cached preference is %s", (raw) => {
    globalThis.localStorage.setItem("yakitori.collapsedSections", raw)
    globalThis.localStorage.setItem("unrelated.preference", "keep")
    expect(createInitialAppState().collapsedSections).toEqual({})
    expect(globalThis.localStorage.getItem("unrelated.preference")).toBe("keep")
    expect(globalThis.localStorage.getItem("yakitori.collapsedSections")).toBe(
      raw,
    )
  })

  it("restores only collapsed flags from a cached section record", () => {
    globalThis.localStorage.setItem(
      "yakitori.collapsedSections",
      JSON.stringify({ work: true, personal: false, invalid: "true" }),
    )
    expect(createInitialAppState().collapsedSections).toEqual({ work: true })
  })

  it.each([
    ["https://app.test/nested?view=chat#session", "https://app.test"],
    [
      "https://app.test/?api=http%3A%2F%2F127.0.0.1%3A4141",
      "http://127.0.0.1:4141",
    ],
    ["https://app.test/?api=", "https://app.test"],
  ])("selects its API origin from %s", (href, expected) => {
    vi.stubGlobal("location", new URL(href))
    expect(createInitialAppState().apiBase).toBe(expected)
  })

  it("rehydrates collapsed sections after closing and reopening them", () => {
    useAppStore.getState().setSectionOpen("work", false)
    useAppStore.getState().setSectionOpen("personal", false)
    expect(createInitialAppState().collapsedSections).toEqual({
      work: true,
      personal: true,
    })

    useAppStore.getState().setSectionOpen("work", true)
    expect(createInitialAppState().collapsedSections).toEqual({
      personal: true,
    })
  })
})

describe("app store event stream", () => {
  it("keeps model retries and terminal turn errors out of the global message", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    stream?.emitReplayComplete()
    stream?.emitTransient({
      type: "runtime.warning",
      sessionId: "session_1",
      turnId: "turn_1",
      code: "model.retry",
      message: "Model request failed; retrying.",
      details: {
        kind: "connection_failed",
        nextAttempt: 2,
        maxAttempts: 4,
        delayMs: 336,
      },
      createdAt: sessionDetail.createdAt,
    })
    expect(useAppStore.getState().message).toBeUndefined()
    expect(
      projectExecutionView(useAppStore.getState().execution).activeRetry,
    ).toMatchObject({ nextAttempt: 2, maxAttempts: 4 })

    stream?.emitTransient({
      type: "session.error",
      sessionId: "session_1",
      operation: "turn_input",
      message: "Connection failed",
      createdAt: sessionDetail.createdAt,
    })
    stream?.emitTransient({
      type: "turn.finished",
      sessionId: "session_1",
      turnId: "turn_1",
      outcome: {
        status: "failed",
        error: { message: "Connection failed" },
      },
      createdAt: sessionDetail.createdAt,
    })
    const view = projectExecutionView(useAppStore.getState().execution)
    expect(useAppStore.getState().message).toBeUndefined()
    expect(view.activeRetry).toBeUndefined()
    expect(view.entries).toContainEqual(
      expect.objectContaining({
        kind: "turn_terminal",
        state: "failed",
        message: "Connection failed",
      }),
    )
  })

  it("continues to surface operational failures and other runtime warnings", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream)
    stream?.emitReplayComplete()
    stream?.emitTransient({
      type: "session.error",
      sessionId: "session_1",
      operation: "persistence",
      message: "Could not save the session",
      createdAt: sessionDetail.createdAt,
    })
    expect(useAppStore.getState().message).toBe("Could not save the session")
    stream?.emitTransient({
      type: "runtime.warning",
      sessionId: "session_1",
      turnId: "turn_1",
      code: "other.warning",
      message: "Another warning",
      createdAt: sessionDetail.createdAt,
    })
    expect(useAppStore.getState().message).toBe("Another warning")
  })

  it("reconciles orphaned history with the idle session after replay", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, seq: 3 })
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.TurnStarted,
          data: { turnId: "orphan", inputId: "input_1" },
        },
      }),
    )
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 3,
        event: {
          type: EventType.ItemCompleted,
          data: {
            turnId: "orphan",
            item: {
              type: "reasoning",
              itemId: "reasoning_1",
              text: "Checking",
            },
          },
        },
      }),
    )
    stream?.emitReplayComplete()

    const view = projectExecutionView(useAppStore.getState().execution)
    expect(view.activeTurnId).toBeUndefined()
    expect(view.activeActivity).toBeUndefined()
    expect(view.entries).toEqual([
      expect.objectContaining({ kind: "reasoning", text: "Checking" }),
      expect.objectContaining({
        kind: "turn_terminal",
        turnId: "orphan",
        state: "interrupted",
      }),
    ])
    expect(useAppStore.getState().hydratingSessionId).toBeUndefined()

    // A later live start belongs to the new execution, beyond the snapshot.
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 4,
        event: {
          type: EventType.TurnStarted,
          data: { turnId: "new_turn", inputId: "input_2" },
        },
      }),
    )
    expect(
      projectExecutionView(useAppStore.getState().execution).activeTurnId,
    ).toBe("new_turn")
  })

  it("preserves the resident turn while reconciling older abandoned turns", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, {
      ...sessionDetail,
      seq: 3,
      activeTurnId: "resident",
    })
    for (const [seq, turnId] of [
      [2, "orphan"],
      [3, "resident"],
    ] as const) {
      stream?.emitEvent(
        createEventEnvelope({
          sessionId: "session_1",
          seq,
          event: {
            type: EventType.TurnStarted,
            data: { turnId, inputId: `input_${turnId}` },
          },
        }),
      )
    }
    stream?.emitReplayComplete()
    const view = projectExecutionView(useAppStore.getState().execution)
    expect(view.activeTurnId).toBe("resident")
    expect(view.activeActivity).toEqual({ kind: "reasoning" })
    expect(view.entries).toEqual([
      expect.objectContaining({
        kind: "turn_terminal",
        turnId: "orphan",
        state: "interrupted",
      }),
    ])
  })

  it("does not restore a snapshot's active turn over a newer completion", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, seq: 2, activeTurnId: "turn_1" })
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 3,
        event: {
          type: EventType.TurnCompleted,
          data: { turnId: "turn_1", outcome: { status: "completed" } },
        },
      }),
    )
    stream?.emitReplayComplete()
    expect(
      projectExecutionView(useAppStore.getState().execution).activeTurnId,
    ).toBeUndefined()
  })

  it("stops presenting active execution when the subscription fails", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    stream?.emitTransient({
      sessionId: "session_1",
      type: "item.started",
      turnId: "turn_1",
      createdAt: sessionDetail.updatedAt,
      item: { type: "reasoning", itemId: "reasoning_1" },
    })
    stream?.emitTransient({
      sessionId: "session_1",
      type: "reasoning.delta",
      streamId: "stream_1",
      offset: 0,
      turnId: "turn_1",
      itemId: "reasoning_1",
      delta: "Checking",
      createdAt: sessionDetail.updatedAt,
    })
    stream?.failSubscription(new Error("Session event replay failed."))
    const view = projectExecutionView(useAppStore.getState().execution)
    expect(view.activeTurnId).toBeUndefined()
    expect(view.activeActivity).toBeUndefined()
    expect(view.entries).toEqual([
      expect.objectContaining({
        kind: "reasoning",
        text: "Checking",
        status: "suspended",
        incomplete: true,
      }),
    ])
    expect(useAppStore.getState().stream).toBeUndefined()
    expect(useAppStore.getState().hydratingSessionId).toBeUndefined()
    expect(useAppStore.getState().message).toBe("Session event replay failed.")
  })

  it("leaves hydration on disconnect and resumes after replay on reconnect", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    expect(useAppStore.getState().hydratingSessionId).toBe("session_1")

    stream?.disconnect(new Error("The connection to the server was lost."))
    expect(useAppStore.getState().hydratingSessionId).toBeUndefined()
    expect(useAppStore.getState().message).toBe(
      "The connection to the server was lost.",
    )
    expect(useAppStore.getState().stream).toBe(stream)
    expect(
      projectExecutionView(useAppStore.getState().execution).activeTurnId,
    ).toBeUndefined()

    emitSnapshot(stream, sessionDetail)
    expect(useAppStore.getState().hydratingSessionId).toBe("session_1")
    stream?.emitReplayComplete()
    expect(useAppStore.getState().hydratingSessionId).toBeUndefined()
    expect(useAppStore.getState().message).toBeUndefined()
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
  })

  it("does not reload a session that is already open", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream)
    stream?.emitReplayComplete()
    const opened = fakeRef.current.streams.length
    await useAppStore.getState().selectSession("session_1")
    expect(fakeRef.current.streams).toHaveLength(opened)
    expect(useAppStore.getState().hydratingSessionId).toBeUndefined()
  })

  it("shows a previously opened session without replaying from the start", async () => {
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
            content: inputFixture(inputParts("hello")),
          },
        },
      }),
    )
    stream?.emitReplayComplete()
    await useAppStore.getState().selectSession("session_other")
    await useAppStore.getState().selectSession("session_1")
    expect(fakeRef.current.streams.at(-1)?.after).toBe(2)
    expect(useAppStore.getState().hydratingSessionId).toBeUndefined()
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([
      expect.objectContaining({
        kind: "user_input",
        text: "hello",
      }),
    ])
  })

  it("publishes cached catch-up only after the replay is complete", async () => {
    await useAppStore.getState().selectSession("session_1")
    const initial = fakeRef.current.streams.at(-1)
    emitSnapshot(initial)
    initial?.emitReplayComplete()
    await useAppStore.getState().selectSession("session_other")
    await useAppStore.getState().selectSession("session_1")
    const resumed = fakeRef.current.streams.at(-1)
    const cached = useAppStore.getState().execution
    emitSnapshot(resumed, { ...sessionDetail, seq: 3 })
    resumed?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request_catchup",
            inputId: "input_catchup",
            role: InputRole.User,
            content: inputFixture(inputParts("received while away")),
          },
        },
      }),
    )
    expect(useAppStore.getState().execution).toBe(cached)
    expect(useAppStore.getState().hydratingSessionId).toBeUndefined()
    resumed?.emitReplayComplete()
    expect(useAppStore.getState().execution.entries).toContainEqual(
      expect.objectContaining({
        kind: "user_input",
        text: "received while away",
      }),
    )
  })

  it.each([
    "snapshot",
    "events",
  ])("resumes unapplied history after navigation interrupts replay at %s", async (stage) => {
    await useAppStore.getState().selectSession("session_1")
    const initial = fakeRef.current.streams.at(-1)
    emitSnapshot(initial)
    initial?.emitReplayComplete()
    await useAppStore.getState().selectSession("session_other")
    await useAppStore.getState().selectSession("session_1")
    const resumed = fakeRef.current.streams.at(-1)
    emitSnapshot(resumed, { ...sessionDetail, seq: 30 })
    if (stage === "events")
      resumed?.emitEvent(
        createEventEnvelope({
          sessionId: "session_1",
          seq: 2,
          event: {
            type: EventType.InputAdmitted,
            data: {
              requestId: "request_interrupted_replay",
              inputId: "input_interrupted_replay",
              role: InputRole.User,
              content: inputFixture(inputParts("pending catch-up")),
            },
          },
        }),
      )
    await useAppStore.getState().selectSession("session_other")
    await useAppStore.getState().selectSession("session_1")
    expect(fakeRef.current.streams.at(-1)?.after).toBe(1)
    expect(useAppStore.getState().execution.entries).toEqual([])
  })

  it("retains buffered history when a disconnected replay resumes after received events", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams.at(-1)
    emitSnapshot(stream, { ...sessionDetail, seq: 3 })
    const admitted = createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request_before_disconnect",
          inputId: "input_before_disconnect",
          role: InputRole.User,
          content: inputFixture(inputParts("received before disconnect")),
        },
      },
    })
    stream?.emitEvent(admitted)
    stream?.disconnect(new Error("Disconnected during replay"))
    emitSnapshot(stream, { ...sessionDetail, seq: 3 })
    // Received records may be repeated by another transport. Fold them once.
    stream?.emitEvent(admitted)
    stream?.emitReplayComplete()
    expect(useAppStore.getState().execution.entries).toEqual([
      expect.objectContaining({
        kind: "user_input",
        text: "received before disconnect",
      }),
    ])
    expect(useAppStore.getState().execution.lastSeq).toBe(3)
  })

  it("keeps an acknowledged interrupt pending until its turn completes without touching draft or queue", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    stream?.emitReplayComplete()
    // Let the initial replay's queue read settle before seeding queued state.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const draft = inputParts("next question")
    useAppStore.setState({
      promptDraft: draft,
      execution: {
        ...useAppStore.getState().execution,
        queuedInputs: {
          queued: {
            id: "queued",
            text: "queued question",
            admittedAt: "2026-07-24T00:00:00.000Z",
          },
        },
      },
    })
    fakeRef.current.respond = () => ({ status: "requested" })
    await useAppStore.getState().cancelTurn("turn_1")
    await useAppStore.getState().cancelTurn("turn_1")
    expect(fakeRef.current.requestsFor("session/turn/cancel")).toHaveLength(1)
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_1")).toBe(
      true,
    )
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.TurnCompleted,
          data: { turnId: "turn_1", outcome: { status: "interrupted" } },
        },
      }),
    )
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_1")).toBe(
      false,
    )
    expect(useAppStore.getState().promptDraft).toEqual(draft)
    expect(useAppStore.getState().execution.queuedInputs.queued?.text).toBe(
      "queued question",
    )
    expect(fakeRef.current.requestsFor("session/input/admit")).toHaveLength(0)
  })

  it("keeps an acknowledged interrupt across disconnection until authoritative replay finishes the turn", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    stream?.emitReplayComplete()
    fakeRef.current.respond = () => ({ status: "requested" })
    await useAppStore.getState().cancelTurn("turn_1")
    stream?.disconnect(new Error("connection lost"))
    expect(useAppStore.getState().execution.activeTurnId).toBeUndefined()
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_1")).toBe(
      true,
    )
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    stream?.emitReplayComplete()
    await useAppStore.getState().cancelTurn("turn_1")
    expect(fakeRef.current.requestsFor("session/turn/cancel")).toHaveLength(1)
    emitSnapshot(stream, { ...sessionDetail, seq: 2 })
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_1")).toBe(
      true,
    )
    stream?.emitReplayComplete()
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_1")).toBe(
      false,
    )
  })

  it("allows another interrupt after a failed request and ignores a locally stale turn", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    stream?.emitReplayComplete()
    fakeRef.current.respond = () => {
      throw new Error("cancel unavailable")
    }
    await useAppStore.getState().cancelTurn("old_turn")
    expect(fakeRef.current.requestsFor("session/turn/cancel")).toHaveLength(0)
    await useAppStore.getState().cancelTurn("turn_1")
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_1")).toBe(
      false,
    )
    expect(useAppStore.getState().message).toBe("cancel unavailable")
    fakeRef.current.respond = () => ({ status: "requested" })
    await useAppStore.getState().cancelTurn("turn_1")
    expect(fakeRef.current.requestsFor("session/turn/cancel")).toHaveLength(2)
  })

  it("ignores a late interrupt failure after the addressed turn naturally completes", async () => {
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    stream?.emitReplayComplete()
    const response = deferredResponse()
    fakeRef.current.respond = () => response.promise
    const cancelling = useAppStore.getState().cancelTurn("turn_1")
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.TurnCompleted,
          data: { turnId: "turn_1", outcome: { status: "completed" } },
        },
      }),
    )
    response.reject(new ApiRequestError("turn already finished", "not_found"))
    await cancelling
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_1")).toBe(
      false,
    )
    expect(useAppStore.getState().message).toBeUndefined()
    expect(fakeRef.current.streams).toHaveLength(1)
  })

  it("an old cancel response cannot clear a newer turn's pending interrupt after navigation", async () => {
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0], {
      ...sessionDetail,
      activeTurnId: "turn_1",
    })
    fakeRef.current.streams[0]?.emitReplayComplete()
    const oldResponse = deferredResponse()
    fakeRef.current.respond = () => oldResponse.promise
    const oldCancel = useAppStore.getState().cancelTurn("turn_1")
    await useAppStore.getState().selectSession("session_2")
    emitSnapshot(fakeRef.current.streams[1], {
      ...sessionDetail,
      id: "session_2",
      activeTurnId: "turn_2",
    })
    fakeRef.current.streams[1]?.emitReplayComplete()
    fakeRef.current.respond = () => ({ status: "requested" })
    await useAppStore.getState().cancelTurn("turn_2")
    oldResponse.resolve({ status: "requested" })
    await oldCancel
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_1")).toBe(
      false,
    )
    expect(useAppStore.getState().inFlightActions.has("cancel:turn_2")).toBe(
      true,
    )
    expect(
      fakeRef.current
        .requestsFor("session/turn/cancel")
        .map(({ params }) => params),
    ).toEqual([
      { sessionId: "session_1", turnId: "turn_1", reason: "user_cancel" },
      { sessionId: "session_2", turnId: "turn_2", reason: "user_cancel" },
    ])
  })

  it("resubscribes after a stale interrupt without cancelling a newer turn", async () => {
    await useAppStore.getState().selectSession("session_1")
    const initialStream = fakeRef.current.streams[0]
    emitSnapshot(initialStream, {
      ...sessionDetail,
      seq: 4,
      activeTurnId: "old_turn",
    })
    initialStream?.emitReplayComplete()
    fakeRef.current.respond = () => {
      throw new ApiRequestError(
        "Active Turn old_turn was not found.",
        "not_found",
      )
    }
    await useAppStore.getState().cancelTurn("old_turn")
    expect(initialStream?.closed).toBe(true)
    const replacement = fakeRef.current.streams[1]
    expect(replacement?.after).toBe(4)
    emitSnapshot(replacement, {
      ...sessionDetail,
      seq: 5,
      activeTurnId: "new_turn",
    })
    replacement?.emitReplayComplete()
    expect(
      projectExecutionView(useAppStore.getState().execution).activeTurnId,
    ).toBe("new_turn")
    expect(fakeRef.current.requestsFor("session/turn/cancel")).toEqual([
      {
        method: "session/turn/cancel",
        params: {
          sessionId: "session_1",
          turnId: "old_turn",
          reason: "user_cancel",
        },
      },
    ])
  })

  it("preserves an unavailable selected model until the user chooses another", () => {
    expect(
      resolveEffectiveModel({
        sessionCurrent: { provider: "codex", model: "stale-session" },
        userPreference: { provider: "codex", model: "stale-preference" },
        defaultProvider: "faux",
        defaultModel: "scripted",
      }),
    ).toEqual({ provider: "codex", model: "stale-session" })
  })

  it("streams durable execution events into the store", async () => {
    useAppStore.setState({
      sessionsByProject: { "": { sessions: [sessionDetail] } },
    })
    await useAppStore.getState().selectSession("session_1")

    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream)
    expect(fakeRef.current.requests).toEqual([
      { method: "session/queue/list", params: { sessionId: "session_1" } },
      { method: "session/skills", params: { sessionId: "session_1" } },
    ])
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
          content: inputFixture(inputParts("hello")),
        },
      },
    })
    stream?.emitEvent(admitted)
    expect(useAppStore.getState().hydratingSessionId).toBe("session_1")
    expect(useAppStore.getState().execution.entries).toEqual([])
    expect(useAppStore.getState().selectedSession?.counts.inputs).toBe(1)
    stream?.emitReplayComplete()
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([
      expect.objectContaining({
        kind: "user_input",
        text: "hello",
        content: inputParts("hello"),
      }),
    ])
    expect(useAppStore.getState().hydratingSessionId).toBeUndefined()
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
      streamId: "stream_1",
      offset: 0,
      sessionId: "session_1",
      turnId: "turn_1",
      itemId: "item_1",
      delta: "Hi there",
      createdAt: "2026-07-24T00:00:00.000Z",
    })
    const view = projectExecutionView(useAppStore.getState().execution)
    expect(view.entries).toEqual([
      expect.objectContaining({
        kind: "user_input",
        text: "hello",
        content: inputParts("hello"),
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "Hi there",
        status: "streaming",
      }),
    ])
    expect(useAppStore.getState().selectedSession?.activeTurnId).toBe("turn_1")
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
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([
      expect.objectContaining({
        kind: "user_input",
        text: "hello",
        content: inputParts("hello"),
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "Hi there",
        status: "completed",
      }),
      expect.objectContaining({
        kind: "tool",
        toolCallId: "tool_1",
        state: "completed",
        resultText: "done",
      }),
    ])
    expect(useAppStore.getState().sessionsByProject[""]?.sessions[0]?.seq).toBe(
      5,
    )
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
            content: inputFixture(inputParts("stale")),
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
  it("removes a cancelled item from the separate queue view", async () => {
    let items = [
      {
        id: "input_1",
        sessionId: "session_1",
        input: {
          submissionId: "request_1",
          content: inputFixture(inputParts("hello")),
        },
        createdAt: sessionDetail.createdAt,
      },
    ]
    fakeRef.current.respond = (method) => {
      if (method === "session/queue/list") return { items }
      if (method === "session/input/cancel") {
        items = []
        return { sessionId: "session_1", inputId: "input_1" }
      }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    await vi.waitFor(() =>
      expect(useAppStore.getState().queuedItems).toHaveLength(1),
    )
    await useAppStore.getState().cancelQueuedInput("input_1")
    expect(fakeRef.current.requestsFor("session/input/cancel")).toEqual([
      {
        method: "session/input/cancel",
        params: {
          sessionId: "session_1",
          inputId: "input_1",
          reason: "user_cancel",
        },
      },
    ])
    expect(useAppStore.getState().queuedItems).toEqual([])
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
      rolloutId: `rollout_${id}`,
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
      sessionsByProject: {
        "": { sessions: [summary("session_1"), summary("session_2")] },
      },
    })

    await useAppStore.getState().deleteSession("session_1")

    expect(fakeRef.current.requests).toContainEqual({
      method: "session/delete",
      params: { sessionId: "session_1" },
    })
    expect(
      useAppStore
        .getState()
        .sessionsByProject[""]?.sessions.map((session) => session.id),
    ).toEqual(["session_2"])
    expect(useAppStore.getState().inFlightActions.size).toBe(0)
  })

  it("clears the selection when the selected session is deleted", async () => {
    fakeRef.current.respond = respondToDelete([])

    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
    const stream = fakeRef.current.streams[0]
    useWorkspaceStore.setState({
      tabs: [{ id: "changes", kind: "changes" }],
      sessionId: undefined,
      presentationBySession: {
        "": { open: false, expanded: false, activeId: "changes" },
      },
    })
    useWorkspaceStore.getState().setSession("session_1")
    useWorkspaceStore.getState().addTab("chat", "session_1")

    await useAppStore.getState().deleteSession("session_1")

    expect(useAppStore.getState().selectedSession).toBeUndefined()
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([])
    expect(useAppStore.getState().sessionsByProject[""]?.sessions).toEqual([])
    expect(stream?.closed).toBe(true)
    expect(useWorkspaceStore.getState().sessionId).toBeUndefined()
    expect(
      useWorkspaceStore
        .getState()
        .tabs.filter((tab) => tab.workspaceSessionId === "session_1"),
    ).toEqual([])
  })

  it("keeps the selection when another session is deleted", async () => {
    fakeRef.current.respond = respondToDelete([summary("session_1")])

    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])
    await useAppStore.getState().deleteSession("session_2")

    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
    expect(useAppStore.getState().selection.sessionId).toBe("session_1")
  })

  it("keeps a session's side chat when deleting its parent fails", async () => {
    fakeRef.current.respond = (method) => {
      if (method === "session/delete")
        throw new ApiRequestError("Could not delete", "conflict")
      return notFound()
    }
    useWorkspaceStore.setState({
      tabs: [{ id: "changes", kind: "changes" }],
      sessionId: undefined,
      presentationBySession: {
        "": { open: false, expanded: false, activeId: "changes" },
      },
    })
    useWorkspaceStore.getState().setSession("session_1")
    const sideChatId = useWorkspaceStore.getState().addTab("chat", "session_1")

    await useAppStore.getState().deleteSession("session_1")

    expect(
      useWorkspaceStore.getState().tabs.some((tab) => tab.id === sideChatId),
    ).toBe(true)
  })
})

describe("session drafts", () => {
  const attachment = {
    name: "screenshot.png",
    mediaType: "image/png" as const,
    detail: "high" as const,
    sizeBytes: 9,
    file: {
      rolloutId: "session_1",
      path: "attachments/staging/draft_1/1.png",
    },
  }

  it("parks the active draft on session switch and restores it on return", async () => {
    const skill = {
      name: "Template Creator",
      description: "Creates project templates",
      path: "/repo/.agents/skills/template-creator/SKILL.md",
      scope: "repo" as const,
    }
    await useAppStore.getState().selectSession("session_1")
    useAppStore
      .getState()
      .setPromptDraft(
        inputParts(`draft for one [$${skill.name}](${skill.path})`, [
          attachment,
        ]),
      )

    await useAppStore.getState().selectSession("session_2")

    expect(useAppStore.getState().promptDraft).toBeUndefined()

    useAppStore.getState().setPromptDraft(inputParts("draft for two"))
    await useAppStore.getState().selectSession("session_1")

    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts(
        "draft for one [$Template Creator](/repo/.agents/skills/template-creator/SKILL.md)",
        [attachment],
      ),
    )

    await useAppStore.getState().selectSession("session_2")
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("draft for two"),
    )
  })

  it("does not park an empty draft", async () => {
    await useAppStore.getState().selectSession("session_1")
    useAppStore.getState().setPromptDraft(inputParts("   "))

    await useAppStore.getState().selectSession("session_2")

    expect(useAppStore.getState().sessionDrafts).toEqual({})
  })

  it("drops a parked draft when its session is deleted", async () => {
    fakeRef.current.respond = (method, params) => {
      if (method === "session/delete") {
        return { sessionId: (params as { sessionId: string }).sessionId }
      }
      if (method === "session/list") return { sessions: [] }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    useAppStore.getState().setPromptDraft(inputParts("draft for one"))
    await useAppStore.getState().selectSession("session_2")
    expect(useAppStore.getState().sessionDrafts.session_1).toBeDefined()

    await useAppStore.getState().deleteSession("session_1")

    expect(useAppStore.getState().sessionDrafts).toEqual({})
    expect(useAppStore.getState().selection.sessionId).toBe("session_2")
    expect(useAppStore.getState().promptDraft).toBeUndefined()
  })

  it("clears the live draft when the selected session is deleted", async () => {
    fakeRef.current.respond = (method, params) => {
      if (method === "session/delete") {
        return { sessionId: (params as { sessionId: string }).sessionId }
      }
      if (method === "session/list") return { sessions: [] }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    useAppStore.getState().setPromptDraft(inputParts("draft for one"))

    await useAppStore.getState().deleteSession("session_1")

    expect(useAppStore.getState().promptDraft).toBeUndefined()
    expect(useAppStore.getState().sessionDrafts).toEqual({})
  })
})

describe("revert session", () => {
  it("edits through one revert request and replaces history in the same Session", async () => {
    globalThis.localStorage.clear()
    const activeSession: ApiSessionDetail = {
      ...sessionDetail,
      seq: 3,
      activeTurnId: "turn_1",
      counts: { ...sessionDetail.counts, inputs: 1, turns: 1 },
    }
    const revertedSession: ApiSessionDetail = {
      ...sessionDetail,
      rolloutId: "rollout_reverted",
      seq: 2,
      counts: { ...sessionDetail.counts, inputs: 1 },
    }
    const revertEvents = [
      createEventEnvelope({
        sessionId: "session_1",
        seq: 1,
        event: {
          type: EventType.SessionCreated,
          data: {},
        },
      }),
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "request:replacement",
            inputId: "input_replacement",
            role: InputRole.User,
            content: inputFixture(inputParts("replacement")),
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
      if (method === "session/revert") {
        return {
          session: revertedSession,
          historyEndSeqExclusive: 3,
          events: revertEvents,
        }
      }
      if (method === "session/list") {
        return { sessions: [revertedSession] }
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
            content: inputFixture(inputParts("original")),
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

    const draft = inputParts("next human draft")
    const excerpt = {
      id: "excerpt_draft",
      text: "file context",
      attachedAt: "2026-07-24T00:00:00.000Z",
      source: { kind: "file" as const, label: "README", path: "/p/README" },
    }
    const editorState = { undoDepth: 3 }
    useAppStore.setState({
      threadId: "draft_promoted",
      sessionThreadIds: { session_1: "draft_promoted" },
      promptDraft: draft,
      promptExcerpts: [excerpt],
      sessionsByProject: { "": { sessions: [activeSession] } },
    })
    useWorkspaceStore.getState().setSession("draft_promoted")
    useWorkspaceStore.getState().openFile("/p/README", "/p")
    const workspace = useWorkspaceStore.getState()
    writeThreadScopeValue("draft_promoted", "scroll.position", { top: 99 })
    writeThreadScopeValue(
      "http://api.test:draft_promoted",
      "prompt-editor.state",
      editorState,
    )
    writeThreadScopeValue(
      "http://api.test:draft_promoted",
      "composer.history",
      {
        index: 3,
      },
    )
    await useAppStore
      .getState()
      .revertSession("input_1", "edit", inputFixture(inputParts("replacement")))

    expect(fakeRef.current.requestsFor("session/input/cancel")).toEqual([])
    expect(fakeRef.current.requestsFor("session/revert")).toEqual([
      {
        method: "session/revert",
        params: {
          sessionId: "session_1",
          atInputId: "input_1",
          reason: "edit",
          content: inputFixture(inputParts("replacement")),
          modelSelection: {
            provider: "openai",
            model: "gpt-test",
            effort: "high",
          },
        },
      },
    ])
    expect(useAppStore.getState().selectedSession).toEqual(revertedSession)
    expect(useAppStore.getState().selection.sessionId).toBe("session_1")
    expect(useAppStore.getState().modelSelections.session_1).toEqual({
      provider: "openai",
      model: "gpt-test",
      effort: "high",
    })
    expect(useAppStore.getState().composerFocusRevision).toBe(1)
    expect(useAppStore.getState().sessionHistoryRevisions).toEqual({
      session_1: 1,
    })
    expect(useAppStore.getState().promptDraft).toBe(draft)
    expect(useAppStore.getState().promptExcerpts).toEqual([excerpt])
    expect(useAppStore.getState().threadId).toBe("draft_promoted")
    expect(useAppStore.getState().sessionThreadIds).toEqual({
      session_1: "draft_promoted",
    })
    expect(useAppStore.getState().sessionsByProject[""]?.sessions).toHaveLength(
      1,
    )
    expect(useWorkspaceStore.getState()).toBe(workspace)
    expect(
      readThreadScopeValue("draft_promoted", "scroll.position", undefined),
    ).toBeUndefined()
    expect(
      readThreadScopeValue(
        "http://api.test:draft_promoted",
        "prompt-editor.state",
        undefined,
      ),
    ).toBe(editorState)
    expect(
      readThreadScopeValue(
        "http://api.test:draft_promoted",
        "composer.history",
        undefined,
      ),
    ).toBeUndefined()
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([
      expect.objectContaining({
        kind: "user_input",
        inputId: "input_replacement",
        text: "replacement",
        content: inputParts("replacement"),
      }),
    ])
    expect(stream?.closed).toBe(true)
    const revertStream = fakeRef.current.streams[1]
    expect(revertStream?.sessionId).toBe("session_1")
    expect(revertStream?.after).toBe(2)
  })

  it("undo replaces a high sequence history without submitting input or restoring queued recovery", async () => {
    const oldQueue = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "session/queue/list") return oldQueue.promise
      if (method === "session/revert")
        return { session: sessionDetail, events: [], historyEndSeqExclusive: 2 }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    const oldStream = fakeRef.current.streams[0]
    emitSnapshot(oldStream, { ...sessionDetail, seq: 50 })
    inputRecoveryMemory.reserveAdmission({
      apiBase: "http://api.test",
      sessionId: "session_1",
      content: inputFixture(inputParts("old unknown delivery")),
    })
    oldStream?.emitReplayComplete()
    await useAppStore.getState().revertSession("input_1", "undo")
    oldQueue.resolve({ items: [] })
    await Promise.resolve()
    await Promise.resolve()
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    expect(
      inputRecoveryMemory.listAdmissionsForSession(
        "http://api.test",
        "session_1",
      ),
    ).toEqual([])
    expect(fakeRef.current.requestsFor("session/input")).toEqual([])
    expect(fakeRef.current.requestsFor("session/revert")[0]?.params).toEqual({
      sessionId: "session_1",
      atInputId: "input_1",
      reason: "undo",
    })
    const stream = fakeRef.current.streams.at(-1)
    expect(stream?.after).toBe(1)
    emitSnapshot(stream)
    stream?.emitReplayComplete()
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "fresh",
            inputId: "fresh_input",
            role: InputRole.User,
            content: inputFixture(inputParts("fresh rollout")),
          },
        },
      }),
    )
    oldStream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 51,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: "obsolete",
            inputId: "obsolete_input",
            role: InputRole.User,
            content: inputFixture(inputParts("obsolete rollout")),
          },
        },
      }),
    )
    expect(useAppStore.getState().execution.lastSeq).toBe(2)
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([expect.objectContaining({ inputId: "fresh_input" })])
    await useAppStore.getState().selectSession("session_other")
    await useAppStore.getState().selectSession("session_1")
    expect(fakeRef.current.streams.at(-1)?.after).toBe(2)
  })

  it.each([
    false,
    true,
  ])("invalidates old history after navigation while revert is pending (return before response: %s)", async (returnBeforeResponse) => {
    const response = deferredResponse()
    fakeRef.current.respond = (method) =>
      method === "session/revert" ? response.promise : notFound()
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, seq: 40 })
    stream?.emitReplayComplete()
    useAppStore.getState().setPromptDraft(inputParts("keep draft"))
    const revert = useAppStore.getState().revertSession("input_1", "undo")
    await useAppStore.getState().selectSession("session_other")
    if (returnBeforeResponse)
      await useAppStore.getState().selectSession("session_1")
    response.resolve({
      session: sessionDetail,
      events: [],
      historyEndSeqExclusive: 2,
    })
    await revert
    if (!returnBeforeResponse) {
      expect(useAppStore.getState().selection.sessionId).toBe("session_other")
      await useAppStore.getState().selectSession("session_1")
    }
    expect(fakeRef.current.streams.at(-1)?.after).toBe(
      returnBeforeResponse ? 1 : 0,
    )
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("keep draft"))
    expect(useAppStore.getState().execution.lastSeq).toBeLessThan(40)
  })

  it("rejects an earlier history page arriving after same-session undo", async () => {
    const history = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "session/history") return history.promise
      if (method === "session/revert")
        return { session: sessionDetail, events: [], historyEndSeqExclusive: 2 }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    stream?.emitSnapshot({
      session: { ...sessionDetail, seq: 30 },
      historyBefore: 10,
    })
    stream?.emitReplayComplete()
    const earlier = useAppStore.getState().loadEarlierHistory()
    await useAppStore.getState().revertSession("input_1", "undo")
    history.resolve({ events: [], historyBefore: 5 })
    expect(await earlier).toBe(false)
    expect(useAppStore.getState().historyBefore).toBeUndefined()
    expect(useAppStore.getState().execution.lastSeq).toBe(1)
  })

  it("replaces sidebar rollout state immediately and rejects earlier summary and list reads", async () => {
    const oldSummary = deferredResponse()
    const oldList = deferredResponse()
    const previous = {
      ...sessionDetail,
      seq: 40,
      active: true,
      status: "failed" as const,
      latestCompletionSeq: 38,
    }
    const replacement = {
      ...sessionDetail,
      rolloutId: "rollout_reverted",
      seq: 2,
      active: false,
      status: "idle" as const,
    }
    let listReads = 0
    fakeRef.current.respond = (method) => {
      if (method === "session/list") {
        listReads += 1
        return listReads === 1 ? { sessions: [previous] } : oldList.promise
      }
      if (method === "session/summary") return oldSummary.promise
      if (method === "session/revert")
        return { session: replacement, events: [], historyEndSeqExclusive: 3 }
      return notFound()
    }
    await useAppStore.getState().boot()
    await useAppStore.getState().selectSession("session_1")
    fakeRef.current.emitSidebarChanged({ sessionId: "session_1" })
    const pendingList = useAppStore.getState().loadSessions(undefined)
    await useAppStore.getState().revertSession("input_1", "undo")
    expect(useAppStore.getState().sessionsByProject[""]?.sessions).toEqual([
      replacement,
    ])
    expect(
      useAppStore.getState().sessionsByProject[""]?.loading,
    ).toBeUndefined()
    oldSummary.resolve(previous)
    oldList.resolve({ sessions: [previous] })
    expect(await pendingList).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(useAppStore.getState().sessionsByProject[""]?.sessions).toEqual([
      replacement,
    ])
    expect(useAppStore.getState().selectedSession).toEqual(replacement)
  })

  it("clears and refreshes an inactive session's rollout status after remote reset", async () => {
    const freshSummary = deferredResponse()
    const previous = {
      ...sessionDetail,
      title: "Retained title",
      seq: 40,
      active: true,
      status: "failed" as const,
      latestCompletionSeq: 38,
    }
    fakeRef.current.respond = (method) => {
      if (method === "session/list") return { sessions: [previous] }
      if (method === "session/summary") return freshSummary.promise
      return notFound()
    }
    await useAppStore.getState().boot()
    await useAppStore.getState().selectSession("session_other")
    const stream = useAppStore.getState().stream
    fakeRef.current.emitHistoryReset("session_1")
    const row = useAppStore.getState().sessionsByProject[""]?.sessions[0]
    expect(row?.seq).toBe(0)
    expect(row?.title).toBe("Retained title")
    expect(row).not.toHaveProperty("active")
    expect(row).not.toHaveProperty("status")
    expect(row).not.toHaveProperty("latestCompletionSeq")
    const replacement = {
      ...sessionDetail,
      title: "Retained title",
      rolloutId: "rollout_reverted",
      seq: 2,
      active: false,
      status: "idle" as const,
    }
    freshSummary.resolve(replacement)
    await vi.waitFor(() =>
      expect(useAppStore.getState().sessionsByProject[""]?.sessions).toEqual([
        replacement,
      ]),
    )
    expect(useAppStore.getState().stream).toBe(stream)
    expect(useAppStore.getState().selection.sessionId).toBe("session_other")
  })

  it.each([
    "admission",
    "steer",
  ] as const)("ignores an old %s acknowledgement after replacing the rollout", async (kind) => {
    const acknowledgement = deferredResponse()
    const nextAcknowledgement = deferredResponse()
    let sends = 0
    fakeRef.current.respond = (method) => {
      if (method === "session/input" || method === "session/input/steer") {
        sends += 1
        return sends === 1
          ? acknowledgement.promise
          : nextAcknowledgement.promise
      }
      if (method === "session/revert")
        return { session: sessionDetail, events: [], historyEndSeqExclusive: 2 }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, {
      ...sessionDetail,
      ...(kind === "steer" ? { activeTurnId: "turn_old" } : {}),
    })
    stream?.emitReplayComplete()
    useAppStore.getState().setPromptDraft(inputParts("same human draft"))
    const send = useAppStore
      .getState()
      .admitInput(inputParts("same human draft"))
    await useAppStore.getState().revertSession("input_1", "undo")
    const freshStream = fakeRef.current.streams.at(-1)
    emitSnapshot(freshStream)
    freshStream?.emitReplayComplete()
    const nextSend = useAppStore
      .getState()
      .admitInput(inputParts("same human draft"))
    expect(sends).toBe(2)
    const request = fakeRef.current.requestsFor(
      kind === "steer" ? "session/input/steer" : "session/input",
    )[0]?.params as { requestId: string }
    acknowledgement.resolve({
      requestId: request.requestId,
      turnId: "turn_old",
      content: inputFixture(inputParts("same human draft")),
    })
    await send
    expect(useAppStore.getState().inFlightActions.has("admit:session_1")).toBe(
      true,
    )
    nextAcknowledgement.reject(
      new ApiRequestError("New input rejected", "conflict"),
    )
    await nextSend
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("same human draft"),
    )
    expect(useAppStore.getState().pendingSteers.session_1).toEqual([])
    expect(
      inputRecoveryMemory.readSteers("http://api.test", "session_1"),
    ).toEqual([])
    expect(
      inputRecoveryMemory.listAdmissionsForSession(
        "http://api.test",
        "session_1",
      ),
    ).toEqual([])
  })

  it("rebuilds a selected session on history reset while retaining its draft", async () => {
    await useAppStore.getState().boot()
    await useAppStore.getState().selectSession("session_1")
    const oldStream = fakeRef.current.streams.at(-1)
    emitSnapshot(oldStream, { ...sessionDetail, seq: 20 })
    oldStream?.emitReplayComplete()
    useAppStore.getState().setPromptDraft(inputParts("human draft"))
    fakeRef.current.emitHistoryReset("session_1")
    expect(oldStream?.closed).toBe(true)
    expect(fakeRef.current.streams.at(-1)?.after).toBe(0)
    expect(useAppStore.getState().execution.lastSeq).toBe(0)
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("human draft"),
    )
  })

  it("invalidates an inactive session cache on a remote history reset", async () => {
    await useAppStore.getState().boot()
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams.at(-1)
    emitSnapshot(stream, { ...sessionDetail, seq: 20 })
    stream?.emitReplayComplete()
    useAppStore.getState().setPromptDraft(inputParts("parked human draft"))
    await useAppStore.getState().selectSession("session_other")
    const otherStream = fakeRef.current.streams.at(-1)
    fakeRef.current.emitHistoryReset("session_1")
    expect(useAppStore.getState().selection.sessionId).toBe("session_other")
    expect(useAppStore.getState().stream).toBe(otherStream)
    await useAppStore.getState().selectSession("session_1")
    expect(fakeRef.current.streams.at(-1)?.after).toBe(0)
    expect(useAppStore.getState().execution.lastSeq).toBe(0)
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("parked human draft"),
    )
  })

  it("invalidates every cached history on reconnect without changing drafts or navigation versions", async () => {
    await useAppStore.getState().boot()
    await useAppStore.getState().selectSession("session_1")
    const firstStream = fakeRef.current.streams.at(-1)
    emitSnapshot(firstStream, { ...sessionDetail, seq: 20 })
    firstStream?.emitReplayComplete()
    useAppStore.getState().setPromptDraft(inputParts("first draft"))
    await useAppStore.getState().selectSession("session_other")
    const otherStream = fakeRef.current.streams.at(-1)
    emitSnapshot(otherStream, {
      ...sessionDetail,
      id: "session_other",
      seq: 30,
    })
    otherStream?.emitReplayComplete()
    useAppStore.getState().setPromptDraft(inputParts("other draft"))
    for (const sessionId of ["session_1", "session_other"])
      inputRecoveryMemory.reserveAdmission({
        apiBase: "http://api.test",
        sessionId,
        content: inputFixture(inputParts("old recovery")),
      })
    expect(useAppStore.getState().sessionHistoryRevisions).toEqual({})
    fakeRef.current.emitHistoryReset()
    expect(useAppStore.getState().selection.sessionId).toBe("session_other")
    expect(otherStream?.closed).toBe(true)
    expect(fakeRef.current.streams.at(-1)?.after).toBe(0)
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("other draft"),
    )
    expect(useAppStore.getState().sessionHistoryRevisions).toEqual({
      session_1: 1,
      session_other: 1,
    })
    expect(
      inputRecoveryMemory.listAdmissionsForApiBase("http://api.test"),
    ).toHaveLength(2)
    await useAppStore.getState().selectSession("session_1")
    expect(fakeRef.current.streams.at(-1)?.after).toBe(0)
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("first draft"),
    )
    expect(useAppStore.getState().sessionHistoryRevisions).toEqual({
      session_1: 1,
      session_other: 1,
    })
    fakeRef.current.emitHistoryReset("session_1")
    expect(useAppStore.getState().sessionHistoryRevisions).toEqual({
      session_1: 2,
      session_other: 1,
    })
    expect(
      inputRecoveryMemory.listAdmissionsForSession(
        "http://api.test",
        "session_1",
      ),
    ).toEqual([])
  })

  it.each([
    false,
    true,
  ])("keeps reconnect recovery until its rollout is confirmed (changed: %s)", async (changed) => {
    await useAppStore.getState().boot()
    fakeRef.current.respond = (method) => {
      if (method === "session/queue/list") return { items: [] }
      if (method === "session/skills") return { skills: [] }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    const original = fakeRef.current.streams.at(-1)
    emitSnapshot(original)
    original?.emitReplayComplete()
    const admission = inputRecoveryMemory.reserveAdmission({
      apiBase: "http://api.test",
      sessionId: "session_1",
      content: inputFixture(inputParts("unconfirmed")),
    })
    fakeRef.current.emitHistoryReset()
    expect(
      inputRecoveryMemory.listAdmissionsForSession(
        "http://api.test",
        "session_1",
      ),
    ).toHaveLength(1)
    const reconnect = fakeRef.current.streams.at(-1)
    expect(reconnect?.after).toBe(0)
    expect(reconnect?.options?.recent).toBe(false)
    emitSnapshot(reconnect, {
      ...sessionDetail,
      rolloutId: changed ? "rollout_reverted" : sessionDetail.rolloutId,
    })
    if (changed) {
      expect(reconnect?.closed).toBe(true)
      expect(
        inputRecoveryMemory.listAdmissionsForSession(
          "http://api.test",
          "session_1",
        ),
      ).toEqual([])
      expect(useAppStore.getState().promptDraft).toBeUndefined()
    } else {
      reconnect?.emitEvent(
        createEventEnvelope({
          sessionId: "session_1",
          seq: 2,
          event: {
            type: EventType.InputAdmitted,
            data: {
              requestId: admission.requestId,
              inputId: "confirmed_input",
              role: InputRole.User,
              content: admission.content,
            },
          },
        }),
      )
      reconnect?.emitReplayComplete()
      await vi.waitFor(() =>
        expect(
          inputRecoveryMemory.listAdmissionsForSession(
            "http://api.test",
            "session_1",
          ),
        ).toEqual([]),
      )
      expect(useAppStore.getState().promptDraft).toBeUndefined()
      expect(
        useAppStore.getState().execution.admittedRequestIds[
          admission.requestId
        ],
      ).toBe(true)
    }
  })

  it.each([
    "response",
    "lost acknowledgement",
  ] as const)("defers a local history reset until the revert %s settles", async (outcome) => {
    await useAppStore.getState().boot()
    const response = deferredResponse()
    fakeRef.current.respond = (method) =>
      method === "session/revert" ? response.promise : notFound()
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams.at(-1)
    emitSnapshot(stream, { ...sessionDetail, seq: 20 })
    stream?.emitReplayComplete()
    const revert = useAppStore.getState().revertSession("input_1", "undo")
    fakeRef.current.emitHistoryReset("session_1")
    expect(fakeRef.current.streams).toHaveLength(1)
    if (outcome === "response")
      response.resolve({
        session: sessionDetail,
        events: [],
        historyEndSeqExclusive: 2,
      })
    else response.reject(new Error("The connection to the server was lost."))
    await revert
    expect(fakeRef.current.streams).toHaveLength(2)
    expect(fakeRef.current.streams.at(-1)?.after).toBe(
      outcome === "response" ? 1 : 0,
    )
    expect(useAppStore.getState().execution.lastSeq).toBeLessThan(20)
  })
})

describe("project state", () => {
  const projectA = makeProject("project_a", "/p/a", "Alpha")
  const projectB = makeProject("project_b", "/p/b")

  it("loads skills for a project draft and clears them when no project is selected", async () => {
    globalThis.localStorage.clear()
    const skill = {
      name: "review",
      description: "Review code",
      path: "/p/a/.agents/skills/review/SKILL.md",
      scope: "repo" as const,
    }
    fakeRef.current.respond = (method, params) => {
      if (method === "project/list") return { projects: [projectA, projectB] }
      if (method === "session/skills")
        return {
          skills:
            (params as { projectId: string }).projectId === "project_a"
              ? [skill]
              : [],
        }
      return notFound()
    }

    await useAppStore.getState().loadProjects()
    await vi.waitFor(() => {
      expect(useAppStore.getState().sessionSkills).toEqual([skill])
    })
    expect(fakeRef.current.requestsFor("session/skills")).toEqual([
      { method: "session/skills", params: { projectId: "project_a" } },
    ])

    useAppStore.getState().setNewSessionProject(undefined)
    expect(useAppStore.getState().sessionSkills).toEqual([])
    expect(fakeRef.current.requestsFor("session/skills")).toHaveLength(1)
  })

  it("ignores stale skill responses after the draft project changes", async () => {
    globalThis.localStorage.clear()
    const first = deferredResponse()
    const second = deferredResponse()
    const skillB = {
      name: "beta",
      description: "Beta",
      path: "/p/b/.agents/skills/beta/SKILL.md",
      scope: "repo" as const,
    }
    fakeRef.current.respond = (method, params) => {
      if (method === "project/list") return { projects: [projectA, projectB] }
      if (method === "session/skills")
        return (params as { projectId: string }).projectId === "project_a"
          ? first.promise
          : second.promise
      return notFound()
    }
    await useAppStore.getState().loadProjects()
    useAppStore.getState().setNewSessionProject("project_b")
    second.resolve({ skills: [skillB] })
    await vi.waitFor(() => {
      expect(useAppStore.getState().sessionSkills).toEqual([skillB])
    })
    first.resolve({
      skills: [
        {
          name: "alpha",
          description: "Alpha",
          path: "/p/a/.agents/skills/alpha/SKILL.md",
          scope: "repo",
        },
      ],
    })
    await first.promise
    expect(useAppStore.getState().sessionSkills).toEqual([skillB])
    expect(fakeRef.current.requestsFor("session/skills")).toEqual([
      { method: "session/skills", params: { projectId: "project_a" } },
      { method: "session/skills", params: { projectId: "project_b" } },
    ])
  })

  it("loads projects, falls back to the first project, and tolerates failures", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = (method) => {
      if (method === "project/list") {
        return { projects: [projectA, projectB] }
      }
      return notFound()
    }

    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().projects).toEqual([projectA, projectB])
    expect(useAppStore.getState().currentProject).toBe("project_a")

    fakeRef.current.respond = () => notFound()
    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().projects).toEqual([projectA, projectB])
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("prefers a remembered project that is still registered", async () => {
    globalThis.localStorage.clear()
    globalThis.localStorage.setItem("yakitori.project", "project_b")
    fakeRef.current.respond = (method) => {
      if (method === "project/list") {
        return { projects: [projectA, projectB] }
      }
      return notFound()
    }

    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().currentProject).toBe("project_b")
  })

  it("keeps an explicit no-project selection across list refreshes", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = (method) => {
      if (method === "project/list") {
        return { projects: [projectA, projectB] }
      }
      return notFound()
    }

    await useAppStore.getState().loadProjects()
    expect(useAppStore.getState().currentProject).toBe("project_a")

    useAppStore.getState().setNewSessionProject(undefined)
    expect(globalThis.localStorage.getItem("yakitori.project")).toBe("")

    await useAppStore.getState().loadProjects()

    expect(useAppStore.getState().currentProject).toBeUndefined()
  })

  it("ignores an older project-list failure after a newer read succeeds", async () => {
    const older = deferredResponse()
    const newer = deferredResponse()
    let calls = 0
    fakeRef.current.respond = (method) => {
      if (method !== "project/list") return notFound()
      calls += 1
      return calls === 1 ? older.promise : newer.promise
    }

    const olderRead = useAppStore.getState().loadProjects()
    const newerRead = useAppStore.getState().loadProjects()
    newer.resolve({ projects: [projectB] })
    await newerRead
    older.reject(new ApiRequestError("stale failure", "internal_error"))
    await olderRead

    expect(useAppStore.getState().projects).toEqual([projectB])
    expect(useAppStore.getState().projectsError).toBeUndefined()
  })

  it("refreshes model availability when a source is configured outside the GUI", async () => {
    let listed: ApiProviderSummary[] = []
    fakeRef.current.respond = (method) => {
      if (method === "project/list") return { projects: [] }
      if (method === "session/list") return { sessions: [] }
      if (method === "provider/list")
        return {
          accounts: [],
          providers: listed,
          defaultProvider: "faux",
          defaultModel: "scripted",
        }
      return notFound()
    }
    await useAppStore.getState().boot()
    expect(useAppStore.getState().providers).toEqual([])
    listed = [
      {
        name: "local",
        models: [{ id: "coder", instructionProfileId: "default" }],
        availability: "available",
      },
    ]
    fakeRef.current.emitProviderChanged()
    await vi.waitFor(() =>
      expect(useAppStore.getState().providers).toEqual(listed),
    )
  })

  it("refreshes the project list on project/changed notifications", async () => {
    globalThis.localStorage.clear()
    let listed = [projectA]
    fakeRef.current.respond = (method) => {
      if (method === "project/list") return { projects: listed }
      if (method === "provider/list") {
        return {
          accounts: [],
          providers: [],
          defaultProvider: "faux",
          defaultModel: "m",
        }
      }
      if (method === "session/list") return { sessions: [] }
      return notFound()
    }

    await useAppStore.getState().boot()
    expect(useAppStore.getState().projects).toEqual([projectA])

    listed = [projectA, projectB]
    fakeRef.current.requests.length = 0
    fakeRef.current.emitProjectChanged({
      projectId: "project_b",
      changeType: "created",
    })
    await vi.waitFor(() => {
      expect(useAppStore.getState().projects).toEqual([projectA, projectB])
    })
    expect(fakeRef.current.requestsFor("project/list")).toHaveLength(1)
  })

  it("expanding a project loads its sessions without changing the new-session target", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = (method) => {
      if (method === "session/list") {
        return { sessions: [] }
      }
      return notFound()
    }
    useAppStore.setState({
      projects: [projectA, projectB],
      currentProject: "project_a",
      collapsedProjects: { project_b: true },
    })

    await useAppStore.getState().toggleProject("project_b")

    expect(useAppStore.getState().currentProject).toBe("project_a")
    expect(useAppStore.getState().collapsedProjects).toEqual({})
    expect(globalThis.localStorage.getItem("yakitori.project")).toBeNull()
    expect(globalThis.localStorage.getItem("yakitori.collapsedProjects")).toBe(
      "{}",
    )
    expect(fakeRef.current.requestsFor("session/list")).toEqual([
      {
        method: "session/list",
        params: { limit: 30, projectId: "project_b", sectionId: null },
      },
    ])
    expect(useAppStore.getState().sessionsByProject.project_b).toBeDefined()

    await useAppStore.getState().toggleProject("project_b")

    expect(useAppStore.getState().collapsedProjects).toEqual({
      project_b: true,
    })
    expect(
      globalThis.localStorage.getItem("yakitori.collapsedProjects"),
    ).toContain("project_b")
    // Collapsing needs no further session load.
    expect(fakeRef.current.requestsFor("session/list")).toHaveLength(1)
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
    useAppStore.setState({ currentProject: "project_a" })

    const slow = useAppStore.getState().loadSessions("project_a")
    const fast = useAppStore.getState().loadSessions("project_a")
    resolveSecond?.({
      sessions: [{ ...sessionDetail, id: "session_new" }],
    })
    await fast
    resolveFirst?.({
      sessions: [{ ...sessionDetail, id: "session_old" }],
    })
    await slow

    expect(
      useAppStore
        .getState()
        .sessionsByProject.project_a?.sessions.map((session) => session.id),
    ).toEqual(["session_new"])
  })

  it("opening a project starts a draft and preserves the previous conversation draft", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = (method) => {
      if (method === "project/open") {
        return { project: projectB }
      }
      if (method === "project/list") {
        return { projects: [projectA, projectB] }
      }
      if (method === "session/list") {
        return { sessions: [] }
      }
      return notFound()
    }
    useAppStore.setState({
      projects: [projectA],
      currentProject: "project_a",
      selection: { sessionId: "session_existing" },
      promptDraft: inputParts("unfinished message"),
      collapsedProjects: { project_b: true },
    })

    await useAppStore.getState().addProject(" /p/b ", "My project")

    expect(fakeRef.current.requestsFor("project/open")).toEqual([
      { method: "project/open", params: { path: "/p/b", name: "My project" } },
    ])
    expect(useAppStore.getState().projects).toEqual([projectA, projectB])
    expect(useAppStore.getState().currentProject).toBe("project_b")
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    expect(
      useAppStore.getState().sessionDrafts.session_existing?.content,
    ).toEqual(inputParts("unfinished message"))
    expect(useAppStore.getState().collapsedProjects.project_b).toBeUndefined()
    expect(fakeRef.current.requestsFor("session/create")).toEqual([])
  })

  it("toggleProjectPinned reorders immediately and absorbs the update response", async () => {
    const gate = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "project/update") return gate.promise
      return notFound()
    }
    useAppStore.setState({ projects: [projectB, projectA] })

    const pinning = useAppStore.getState().toggleProjectPinned("project_a")

    expect(
      useAppStore.getState().projects.map((project) => project.id),
    ).toEqual(["project_a", "project_b"])
    expect(useAppStore.getState().projects[0]?.pinned).toBe(true)
    expect(fakeRef.current.requestsFor("project/update")).toEqual([
      {
        method: "project/update",
        params: { projectId: "project_a", pinned: true },
      },
    ])
    expect(fakeRef.current.requestsFor("project/list")).toHaveLength(0)

    gate.resolve({ project: { ...projectA, pinned: true, updatedAt: 1 } })
    expect(await pinning).toBe(true)
    expect(fakeRef.current.requestsFor("project/list")).toHaveLength(0)
    expect(useAppStore.getState().projects[0]?.pinned).toBe(true)
    expect(useAppStore.getState().projects[0]?.updatedAt).toBe(1)
  })

  it("restores only a project's pinned field when persistence fails", async () => {
    const gate = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "project/update") return gate.promise
      return notFound()
    }
    useAppStore.setState({ projects: [projectA, projectB] })

    const pinning = useAppStore.getState().toggleProjectPinned("project_a")
    expect(useAppStore.getState().projects[0]?.pinned).toBe(true)
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.id === "project_a"
          ? { ...project, name: "Updated elsewhere" }
          : project,
      ),
    }))
    gate.reject(new ApiRequestError("Could not save.", "internal_error"))

    expect(await pinning).toBe(false)
    expect(
      useAppStore
        .getState()
        .projects.find((project) => project.id === "project_a"),
    ).toMatchObject({ name: "Updated elsewhere", pinned: false })
  })

  it("does not restore a project deleted while pin persistence is pending", async () => {
    const gate = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "project/update") return gate.promise
      return notFound()
    }
    useAppStore.setState({ projects: [projectA, projectB] })

    const pinning = useAppStore.getState().toggleProjectPinned("project_a")
    useAppStore.setState({ projects: [projectB] })
    gate.reject(new ApiRequestError("Could not save.", "internal_error"))

    expect(await pinning).toBe(false)
    expect(useAppStore.getState().projects).toEqual([projectB])
  })

  it("restores the last confirmed project pin after overlapping failures", async () => {
    const first = deferredResponse()
    const second = deferredResponse()
    let calls = 0
    fakeRef.current.respond = (method) => {
      if (method !== "project/update") return notFound()
      calls += 1
      return calls === 1 ? first.promise : second.promise
    }
    useAppStore.setState({ projects: [projectA, projectB] })

    const pinning = useAppStore.getState().toggleProjectPinned("project_a")
    const unpinning = useAppStore.getState().toggleProjectPinned("project_a")
    expect(
      useAppStore
        .getState()
        .projects.find((project) => project.id === "project_a")?.pinned,
    ).toBe(false)
    first.reject(new ApiRequestError("First failed.", "internal_error"))
    second.reject(new ApiRequestError("Second failed.", "internal_error"))

    expect(await pinning).toBe(false)
    expect(await unpinning).toBe(false)
    expect(
      useAppStore
        .getState()
        .projects.find((project) => project.id === "project_a")?.pinned,
    ).toBe(false)
  })

  it("removeProject deletes, reloads, and retargets the current project", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = (method) => {
      if (method === "project/delete") return {}
      if (method === "project/list") return { projects: [projectB] }
      return notFound()
    }
    useAppStore.setState({
      projects: [projectA, projectB],
      currentProject: "project_a",
      sessionsByProject: { project_a: { sessions: [] } },
    })

    const completed = await useAppStore.getState().removeProject("project_a")

    expect(completed).toBe(true)
    expect(fakeRef.current.requestsFor("project/delete")).toEqual([
      { method: "project/delete", params: { projectId: "project_a" } },
    ])
    expect(useAppStore.getState().projects).toEqual([projectB])
    expect(useAppStore.getState().currentProject).toBe("project_b")
    expect(useAppStore.getState().sessionsByProject.project_a).toBeUndefined()
  })

  it("createSession sends the current project id and its first root", async () => {
    globalThis.localStorage.clear()
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
    useAppStore.setState({
      projects: [projectA],
      currentProject: "project_a",
    })

    await useAppStore.getState().createSession("Build a sidebar")

    expect(fakeRef.current.requestsFor("session/create")).toEqual([
      {
        method: "session/create",
        params: {
          title: "Build a sidebar",
          projectId: "project_a",
          workingDirectory: "/p/a",
        },
      },
    ])
    expect(useAppStore.getState().selectedSession?.id).toBe("session_1")
  })

  it("keeps explicit createSession calls deduplicated while awaiting creation", async () => {
    const create = deferredResponse()
    fakeRef.current.respond = (method) =>
      method === "session/create" ? create.promise : notFound()
    const first = useAppStore.getState().createSession("First")
    const duplicate = useAppStore.getState().createSession("Second")
    expect(await duplicate).toBeUndefined()
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    create.resolve({
      session: sessionDetail,
      event: createEventEnvelope({
        sessionId: "session_1",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    expect(await first).toBe("session_1")
  })
})

describe("model selection", () => {
  it("persists selections per session and rehydrates from localStorage", () => {
    globalThis.localStorage.clear()

    useAppStore.getState().setModelSelection("session_1", {
      provider: "openai",
      model: "gpt-5.1-codex",
      effort: "high",
    })
    useAppStore
      .getState()
      .setModelSelection("session_2", { provider: "kimi-code", model: "k2" })

    const expected = {
      session_1: { provider: "openai", model: "gpt-5.1-codex", effort: "high" },
      session_2: { provider: "kimi-code", model: "k2" },
    }
    expect(useAppStore.getState().modelSelections).toEqual(expected)
    expect(
      JSON.parse(
        globalThis.localStorage.getItem("yakitori.modelSelections") ?? "{}",
      ),
    ).toEqual(expected)
    expect(createInitialAppState().modelSelections).toEqual(expected)

    useAppStore.getState().setModelSelection("session_1", undefined)
    expect(useAppStore.getState().modelSelections).toEqual({
      session_2: { provider: "kimi-code", model: "k2" },
    })
    expect(createInitialAppState().modelSelections).toEqual({
      session_2: { provider: "kimi-code", model: "k2" },
    })
  })

  it("preserves the last model catalog and exposes a server failure until refresh succeeds", async () => {
    fakeRef.current.respond = (method) => {
      if (method === "provider/list") {
        return {
          accounts: [],
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
    expect(useAppStore.getState().providersError).toBe("not found")
    fakeRef.current.respond = () => ({
      accounts: [],
      providers: [],
      defaultProvider: "faux",
      defaultModel: "scripted",
    })
    await useAppStore.getState().loadProviders()
    expect(useAppStore.getState().providersError).toBeUndefined()
  })

  it("lets unexpected catalog failures remain visible as rejected operations", async () => {
    const error = new Error("Catalog invariant failed")
    fakeRef.current.respond = () => {
      throw error
    }
    await expect(useAppStore.getState().loadProviders()).rejects.toBe(error)
  })

  it.each([
    "success",
    "failure",
  ] as const)("keeps the newest catalog after an older %s completes", async (outcome) => {
    const older = deferredResponse()
    const newer = deferredResponse()
    fakeRef.current.respond = () =>
      fakeRef.current.requestsFor("provider/list").length === 1
        ? older.promise
        : newer.promise
    useAppStore.setState({ providersError: "Previous catalog failed" })
    const firstRead = useAppStore.getState().loadProviders()
    const lastRead = useAppStore.getState().loadProviders()
    newer.resolve({
      accounts: [],
      providers: [{ name: "new-provider", models: [] }],
      defaultProvider: "new-provider",
      defaultModel: "new-model",
    })
    await lastRead
    if (outcome === "failure")
      older.reject(new ApiRequestError("Old catalog failed", "internal_error"))
    else
      older.resolve({
        accounts: [],
        providers: [{ name: "old-provider", models: [] }],
        defaultProvider: "old-provider",
        defaultModel: "old-model",
      })
    await firstRead
    expect(useAppStore.getState().providers).toEqual([
      { name: "new-provider", models: [] },
    ])
    expect(useAppStore.getState().defaultProvider).toBe("new-provider")
    expect(useAppStore.getState().defaultModel).toBe("new-model")
    expect(useAppStore.getState().providersError).toBeUndefined()
  })

  it("updates subscription providers independently and preserves stale data on failure", async () => {
    const pending = {
      codex: deferredResponse(),
      grok: deferredResponse(),
      "kimi-code": deferredResponse(),
    }
    fakeRef.current.respond = (method, params) => {
      if (method === "provider/configuration/read")
        return {
          providers: Object.keys(pending).map((id) => ({
            id,
            configuration: { enabled: true },
          })),
        }
      if (method !== "subscription/read") return notFound()
      return pending[(params as { provider: keyof typeof pending }).provider]
        .promise
    }
    useAppStore.setState({
      subscriptionsByProvider: {
        codex: { loading: false },
        grok: {
          loading: false,
          updatedAt: 100,
          subscription: {
            provider: "grok",
            displayName: "Grok",
            availability: "available",
            usage: { status: "unavailable" },
          },
        },
        "kimi-code": { loading: false },
      },
    })

    const loading = useAppStore.getState().loadSubscriptions()

    await vi.waitFor(() =>
      expect(fakeRef.current.requestsFor("subscription/read")).toEqual([
        { method: "subscription/read", params: { provider: "codex" } },
        { method: "subscription/read", params: { provider: "grok" } },
        { method: "subscription/read", params: { provider: "kimi-code" } },
      ]),
    )
    pending.codex.resolve({
      subscription: {
        provider: "codex",
        displayName: "Codex",
        availability: "available",
        plan: "pro",
        usage: {
          status: "available",
          buckets: [{ name: "5-hour limit", usedPercent: 42 }],
        },
      },
      fetchedAt: 123_456,
    })
    await vi.waitFor(() => {
      expect(
        useAppStore.getState().subscriptionsByProvider.codex?.loading,
      ).toBe(false)
    })
    expect(useAppStore.getState().subscriptionsByProvider.grok?.loading).toBe(
      true,
    )
    expect(
      useAppStore.getState().subscriptionsByProvider["kimi-code"]?.loading,
    ).toBe(true)

    pending.grok.reject(new Error("billing unavailable"))
    pending["kimi-code"].resolve({
      subscription: {
        provider: "kimi-code",
        displayName: "Kimi",
        availability: "requires_login",
        usage: { status: "unavailable" },
      },
      fetchedAt: 123_457,
    })
    await loading

    expect(
      useAppStore.getState().subscriptionsByProvider.codex?.subscription,
    ).toMatchObject({
      provider: "codex",
      plan: "pro",
      usage: {
        status: "available",
        buckets: [{ name: "5-hour limit", usedPercent: 42 }],
      },
    })
    expect(useAppStore.getState().subscriptionsByProvider.grok).toMatchObject({
      loading: false,
      error: "Could not update usage.",
      updatedAt: 100,
      subscription: { provider: "grok" },
    })
    expect(
      useAppStore.getState().subscriptionsByProvider["kimi-code"],
    ).toMatchObject({
      loading: false,
      updatedAt: 123_457,
      subscription: { provider: "kimi-code" },
    })
  })

  it("projects a sent prompt immediately and reconciles its durable admission", async () => {
    const optimisticSessionId = "session_optimistic"
    const admission = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "session/input") return admission.promise
      if (method === "session/list") return { sessions: [] }
      if (method === "session/skills") return { skills: [] }
      return notFound()
    }
    await useAppStore.getState().selectSession(optimisticSessionId)
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, id: optimisticSessionId })
    stream?.emitReplayComplete()

    const sending = useAppStore
      .getState()
      .admitInput(inputParts("Show immediately"))
    await vi.waitFor(() =>
      expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1),
    )
    const request = fakeRef.current.requestsFor("session/input")[0]?.params as {
      requestId: string
    }
    expect(useAppStore.getState().execution.entries).toEqual([
      expect.objectContaining({
        kind: "user_input",
        requestId: request.requestId,
        text: "Show immediately",
      }),
    ])

    stream?.emitEvent(
      createEventEnvelope({
        sessionId: optimisticSessionId,
        seq: 2,
        event: {
          type: EventType.TurnStarted,
          data: { turnId: request.requestId, inputId: "input_1" },
        },
      }),
    )
    stream?.emitTransient({
      type: "item.started",
      sessionId: optimisticSessionId,
      turnId: request.requestId,
      item: { type: "agent_message", itemId: "item_1" },
      createdAt: sessionDetail.createdAt,
    })
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: optimisticSessionId,
        seq: 3,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: request.requestId,
            inputId: "input_1",
            role: InputRole.User,
            content: inputFixture(inputParts("Show immediately")),
          },
        },
      }),
    )

    expect(useAppStore.getState().execution.entries).toEqual([
      expect.objectContaining({ kind: "user_input", inputId: "input_1" }),
      expect.objectContaining({ kind: "assistant", itemId: "item_1" }),
    ])
    expect(
      useAppStore
        .getState()
        .execution.entries.filter((entry) => entry.kind === "user_input"),
    ).toHaveLength(1)
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: optimisticSessionId,
        seq: 4,
        event: {
          type: EventType.TurnCompleted,
          data: {
            turnId: request.requestId,
            outcome: { status: "completed" },
          },
        },
      }),
    )
    admission.resolve({
      content: requestedInputContent(request.requestId),
      requestId: request.requestId,
      inputId: "input_1",
    })
    await sending
  })

  it("discards an optimistic prompt when the server rejects its admission", async () => {
    fakeRef.current.respond = (method) => {
      if (method === "session/input") {
        throw new ApiRequestError("Input rejected", "invalid_input")
      }
      return notFound()
    }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: inputParts("Rejected prompt"),
    })

    await useAppStore.getState().admitInput(inputParts("Rejected prompt"))

    expect(useAppStore.getState().execution.entries).toEqual([])
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("Rejected prompt"),
    )
  })

  it("submits inline skill mentions unchanged and clears the admitted draft", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: inputParts(
        "hello [$Template Creator](/repo/.agents/skills/template-creator/SKILL.md)",
      ),
    })

    await useAppStore
      .getState()
      .admitInput(
        inputParts(
          "hello [$Template Creator](/repo/.agents/skills/template-creator/SKILL.md)",
        ),
      )

    const admissions = fakeRef.current.requestsFor("session/input")
    expect(admissions).toHaveLength(1)
    expect(admissions[0]?.params).toMatchObject({
      sessionId: "session_1",
      content: inputFixture(
        inputParts(
          "hello [$Template Creator](/repo/.agents/skills/template-creator/SKILL.md)",
        ),
      ),
    })
    expect(useAppStore.getState().promptDraft).toBeUndefined()
  })

  it("keeps inline mentions edited while an admission is in flight", async () => {
    globalThis.localStorage.clear()
    let release: (() => void) | undefined
    fakeRef.current.respond = (method, params) => {
      if (method === "userPreference/write") return { userPreference: params }
      if (method === "session/list") return { sessions: [] }
      if (method === "session/input") {
        const body = params as { requestId: string }
        return new Promise((resolve) => {
          release = () =>
            resolve({
              content: requestedInputContent(body.requestId),
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
                    content: inputFixture(inputParts("hello [$A](/a)")),
                  },
                },
              }),
            })
        })
      }
      return notFound()
    }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: inputParts("hello [$A](/a)"),
    })

    const pending = useAppStore
      .getState()
      .admitInput(inputParts("hello [$A](/a)"))
    for (
      let attempt = 0;
      attempt < 100 && release === undefined;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    useAppStore.getState().setPromptDraft(inputParts("hello [$A](/a) [$B](/b)"))
    release?.()
    await pending

    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("hello [$A](/a) [$B](/b)"),
    )
  })

  it("sends the saved modelSelection with admitted input", async () => {
    globalThis.localStorage.clear()
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

    await useAppStore.getState().admitInput(inputParts("hello"))

    const admissions = fakeRef.current.requestsFor("session/input")
    expect(admissions).toHaveLength(1)
    expect(admissions[0]?.params).toMatchObject({
      sessionId: "session_1",
      content: inputFixture(inputParts("hello")),
      modelSelection: {
        provider: "openai",
        model: "gpt-5.1-codex",
        effort: "low",
      },
    })
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("steers follow-up input into the active turn", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = (method, params) => {
      if (method === "session/input/steer") {
        const body = params as { requestId: string; expectedTurnId: string }
        return {
          content: requestedInputContent(body.requestId),
          requestId: body.requestId,
          turnId: body.expectedTurnId,
        }
      }
      if (method === "session/list") return { sessions: [] }
      return notFound()
    }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: inputParts("follow up"),
      execution: { ...createExecutionViewState(), activeTurnId: "turn_1" },
    })

    await useAppStore.getState().admitInput(inputParts("follow up"))

    const steers = fakeRef.current.requestsFor("session/input/steer")
    expect(steers).toHaveLength(1)
    expect(steers[0]?.params).toMatchObject({
      sessionId: "session_1",
      expectedTurnId: "turn_1",
      content: inputFixture(inputParts("follow up")),
    })
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(0)
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    // Steering is ephemeral acceptance: no admission outbox entry.
    expect(
      inputRecoveryMemory.listAdmissionsForApiBase(
        useAppStore.getState().apiBase,
      ),
    ).toEqual([])
  })

  it("restores only uncommitted steers when their turn is interrupted", async () => {
    fakeRef.current.respond = (method, params) => {
      if (method === "session/input/steer") {
        const body = params as { requestId: string; expectedTurnId: string }
        return {
          content: requestedInputContent(body.requestId),
          requestId: body.requestId,
          turnId: body.expectedTurnId,
        }
      }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    const stream = fakeRef.current.streams[0]
    emitSnapshot(stream, { ...sessionDetail, activeTurnId: "turn_1" })
    stream?.emitReplayComplete()
    useAppStore.setState({ promptDraft: inputParts("first") })
    await useAppStore.getState().admitInput(inputParts("first"))
    useAppStore.setState({ promptDraft: inputParts("second") })
    await useAppStore.getState().admitInput(inputParts("second"))
    const steers = fakeRef.current.requestsFor("session/input/steer")
    expect(steers).toHaveLength(2)
    const first = steers[0]?.params as { requestId: string }
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: first.requestId,
            inputId: "input_1",
            role: InputRole.User,
            steered: true,
            content: inputFixture(inputParts("first")),
          },
        },
      }),
    )
    useAppStore.setState({ promptDraft: inputParts("new draft") })
    stream?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 3,
        event: {
          type: EventType.TurnCompleted,
          data: {
            turnId: "turn_1",
            outcome: { status: "interrupted", reason: "stop" },
          },
        },
      }),
    )
    expect(useAppStore.getState().promptDraft).toEqual(
      inputFixture([
        { type: "text", text: "second" },
        { type: "text", text: "\n" },
        { type: "text", text: "new draft" },
      ]),
    )
    expect(useAppStore.getState().pendingSteers.session_1).toEqual([])
    expect(fakeRef.current.requestsFor("session/input/queue")).toHaveLength(0)
  })

  it("reconciles pending steers after navigation and replay", async () => {
    fakeRef.current.respond = (method, params) => {
      if (method === "session/input/steer") {
        const body = params as { requestId: string; expectedTurnId: string }
        return {
          content: requestedInputContent(body.requestId),
          requestId: body.requestId,
          turnId: body.expectedTurnId,
        }
      }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0], {
      ...sessionDetail,
      activeTurnId: "turn_1",
    })
    fakeRef.current.streams[0]?.emitReplayComplete()
    for (const text of ["first", "second"]) {
      useAppStore.setState({ promptDraft: inputParts(text) })
      await useAppStore.getState().admitInput(inputParts(text))
    }
    await useAppStore.getState().selectSession("session_2")
    await useAppStore.getState().selectSession("session_1")
    const replay = fakeRef.current.streams.at(-1)
    emitSnapshot(replay, { ...sessionDetail, seq: 4 })
    const steers = fakeRef.current.requestsFor("session/input/steer")
    replay?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: (steers[0]?.params as { requestId: string }).requestId,
            inputId: "input_1",
            role: InputRole.User,
            steered: true,
            content: inputFixture(inputParts("first")),
          },
        },
      }),
    )
    replay?.emitReplayComplete()
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("second"))
    expect(useAppStore.getState().pendingSteers.session_1).toEqual([])
    replay?.emitReplayComplete()
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("second"))
  })

  it("keeps a pending steer across stream failure until reconnect replay resolves it", async () => {
    fakeRef.current.respond = (method, params) => {
      if (method === "session/input/steer") {
        const body = params as { requestId: string; expectedTurnId: string }
        return {
          content: requestedInputContent(body.requestId),
          requestId: body.requestId,
          turnId: body.expectedTurnId,
        }
      }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    const first = fakeRef.current.streams[0]
    emitSnapshot(first, { ...sessionDetail, activeTurnId: "turn_1" })
    first?.emitReplayComplete()
    useAppStore.setState({ promptDraft: inputParts("reconnect") })
    await useAppStore.getState().admitInput(inputParts("reconnect"))
    first?.failSubscription(new Error("disconnected"))
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    await useAppStore.getState().cancelTurn("turn_1")
    const resumed = fakeRef.current.streams.at(-1)
    expect(resumed).not.toBe(first)
    emitSnapshot(resumed, { ...sessionDetail, seq: 2 })
    resumed?.emitReplayComplete()
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("reconnect"))
    expect(useAppStore.getState().pendingSteers.session_1).toEqual([])
  })

  it("recovers a steer after store reset and restores it once across navigation", async () => {
    fakeRef.current.respond = (method, params) => {
      if (method === "session/input/steer") {
        const body = params as { requestId: string; expectedTurnId: string }
        return {
          content: requestedInputContent(body.requestId),
          requestId: body.requestId,
          turnId: body.expectedTurnId,
        }
      }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0], {
      ...sessionDetail,
      activeTurnId: "turn_1",
    })
    fakeRef.current.streams[0]?.emitReplayComplete()
    useAppStore.setState({ promptDraft: inputParts("survive reload") })
    await useAppStore.getState().admitInput(inputParts("survive reload"))
    expect(
      inputRecoveryMemory.readSteers(
        useAppStore.getState().apiBase,
        "session_1",
      ),
    ).toHaveLength(1)

    useAppStore.getState().stream?.close()
    useAppStore.setState({
      ...createInitialAppState(),
      apiBase: "http://api.test",
    })
    await useAppStore.getState().selectSession("session_1")
    const replay = fakeRef.current.streams.at(-1)
    emitSnapshot(replay, { ...sessionDetail, seq: 3 })
    replay?.emitReplayComplete()
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("survive reload"),
    )

    await useAppStore.getState().selectSession("session_2")
    await useAppStore.getState().selectSession("session_1")
    const selectedAgain = fakeRef.current.streams.at(-1)
    emitSnapshot(selectedAgain, { ...sessionDetail, seq: 3 })
    selectedAgain?.emitReplayComplete()
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("survive reload"),
    )

    useAppStore.getState().stream?.close()
    useAppStore.setState({
      ...createInitialAppState(),
      apiBase: "http://api.test",
    })
    await useAppStore.getState().selectSession("session_1")
    const secondReload = fakeRef.current.streams.at(-1)
    emitSnapshot(secondReload, { ...sessionDetail, seq: 3 })
    secondReload?.emitReplayComplete()
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("survive reload"),
    )
    fakeRef.current.respond = admissionResponder()
    await useAppStore.getState().admitInput(inputParts("survive reload"))
    expect(
      inputRecoveryMemory.readSteers(
        useAppStore.getState().apiBase,
        "session_1",
      ),
    ).toHaveLength(1)
  })

  it("restores promoted image refs after store reset and requeues them on retry", async () => {
    const original = {
      name: "screen.png",
      mediaType: "image/png" as const,
      sizeBytes: 9,
      file: {
        rolloutId: "draft_1",
        path: "attachments/staging/draft_1/1.png",
      },
    }
    const promoted = {
      ...original,
      file: {
        rolloutId: "session_1",
        path: "attachments/requests/request_1/1.png",
      },
    }
    fakeRef.current.respond = (method, params) => {
      if (method === "session/input/steer") {
        const body = params as { requestId: string; expectedTurnId: string }
        return {
          requestId: body.requestId,
          turnId: body.expectedTurnId,
          content: inputFixture(inputParts("inspect image", [promoted])),
        }
      }
      if (method === "session/input/queue") {
        const body = params as { requestId: string }
        return {
          content: requestedInputContent(body.requestId),
          requestId: body.requestId,
          inputId: "input_2",
        }
      }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0], {
      ...sessionDetail,
      activeTurnId: "turn_1",
    })
    fakeRef.current.streams[0]?.emitReplayComplete()
    useAppStore.setState({
      promptDraft: inputParts("inspect image", [original]),
    })
    await useAppStore
      .getState()
      .admitInput(inputParts("inspect image", [original]))
    expect(useAppStore.getState().promptDraft).toBeUndefined()

    useAppStore.getState().stream?.close()
    useAppStore.setState({
      ...createInitialAppState(),
      apiBase: "http://api.test",
    })
    await useAppStore.getState().selectSession("session_1")
    const replay = fakeRef.current.streams.at(-1)
    emitSnapshot(replay, { ...sessionDetail, seq: 3 })
    replay?.emitReplayComplete()
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("inspect image", [promoted]),
    )

    await useAppStore
      .getState()
      .admitInput(inputParts("inspect image", [promoted]), "queue")
    expect(
      fakeRef.current.requestsFor("session/input/queue")[0]?.params,
    ).toMatchObject({
      content: inputFixture(inputParts("inspect image", [promoted])),
    })
    expect(useAppStore.getState().promptDraft).toBeUndefined()
  })

  it("restores a steer whose acceptance arrives after replay found an idle session", async () => {
    const response = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "session/input/steer") return response.promise
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0], {
      ...sessionDetail,
      activeTurnId: "turn_1",
    })
    fakeRef.current.streams[0]?.emitReplayComplete()
    useAppStore.setState({ promptDraft: inputParts("late reply") })
    const submission = useAppStore
      .getState()
      .admitInput(inputParts("late reply"))
    await useAppStore.getState().selectSession("session_2")
    await useAppStore.getState().selectSession("session_1")
    const replay = fakeRef.current.streams.at(-1)
    emitSnapshot(replay, { ...sessionDetail, seq: 3 })
    replay?.emitReplayComplete()
    const steer = fakeRef.current.requestsFor("session/input/steer")[0]
      ?.params as { requestId: string }
    response.resolve({
      content: requestedInputContent(steer.requestId),
      requestId: steer.requestId,
      turnId: "turn_1",
    })
    await submission
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("late reply"))
    expect(useAppStore.getState().pendingSteers.session_1).toEqual([])
    replay?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 4,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: steer.requestId,
            inputId: "input_confirmed",
            role: InputRole.User,
            content: requestedInputContent(steer.requestId),
          },
        },
      }),
    )
    expect(useAppStore.getState().promptDraft).toBeUndefined()
  })

  it.each([
    "live",
    "after navigation",
  ])("keeps promoted recovered steer attachments until durable confirmation %s", async (receipt) => {
    const original = {
      name: "screen.png",
      mediaType: "image/png" as const,
      sizeBytes: 9,
      file: {
        rolloutId: receipt === "live" ? "draft_live" : "draft_navigation",
        path: "attachments/staging/1.png",
      },
    }
    const promoted = {
      ...original,
      file: { rolloutId: "session_1", path: "attachments/requests/1.png" },
    }
    const response = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "session/input/steer") return response.promise
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0], {
      ...sessionDetail,
      activeTurnId: "turn_1",
    })
    fakeRef.current.streams[0]?.emitReplayComplete()
    useAppStore.setState({
      promptDraft: inputParts("inspect image", [original]),
    })
    const submission = useAppStore
      .getState()
      .admitInput(inputParts("inspect image", [original]))
    await useAppStore.getState().selectSession("session_2")
    await useAppStore.getState().selectSession("session_1")
    const replay = fakeRef.current.streams.at(-1)
    emitSnapshot(replay, { ...sessionDetail, seq: 3 })
    replay?.emitReplayComplete()
    expect(
      (useAppStore.getState().promptDraft?.attachments ?? []).filter(
        (attachment) => attachment.mediaType !== "application/pdf",
      ),
    ).toEqual(inputParts("", [original]).attachments)
    const steer = fakeRef.current.requestsFor("session/input/steer")[0]
      ?.params as { requestId: string }
    response.resolve({
      requestId: steer.requestId,
      turnId: "turn_1",
      content: inputFixture(inputParts("inspect image", [promoted])),
    })
    await submission
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("inspect image", [promoted]),
    )
    if (receipt === "after navigation") {
      useAppStore.getState().stream?.close()
      useAppStore.setState({
        ...createInitialAppState(),
        apiBase: "http://api.test",
      })
      await useAppStore.getState().selectSession("session_1")
      emitSnapshot(fakeRef.current.streams.at(-1), { ...sessionDetail, seq: 3 })
      fakeRef.current.streams.at(-1)?.emitReplayComplete()
    }
    expect(
      (useAppStore.getState().promptDraft?.attachments ?? []).filter(
        (attachment) => attachment.mediaType !== "application/pdf",
      ),
    ).toEqual(inputParts("", [promoted]).attachments)
    fakeRef.current.streams.at(-1)?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 4,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: steer.requestId,
            inputId: "input_confirmed",
            role: InputRole.User,
            content: inputFixture(inputParts("inspect image", [promoted])),
          },
        },
      }),
    )
    expect(useAppStore.getState().promptDraft).toBeUndefined()
  })

  it("falls back to a queued admission when the active turn ended before steering", async () => {
    globalThis.localStorage.clear()
    const original = {
      name: "screen.png",
      mediaType: "image/png" as const,
      sizeBytes: 9,
      file: { rolloutId: "draft_1", path: "attachments/staging/1.png" },
    }
    fakeRef.current.respond = (method, params) => {
      if (method === "session/input/steer") {
        throw new ApiRequestError(
          "Input was not submitted: no_active_turn.",
          "conflict",
        )
      }
      if (method === "session/input/queue") {
        const body = params as { requestId: string }
        return {
          content: inputFixture(
            inputParts("follow up", [
              {
                ...original,
                file: {
                  rolloutId: "session_1",
                  path: "attachments/requests/queued/1.png",
                },
              },
            ]),
          ),
          requestId: body.requestId,
          inputId: "input_2",
          event: createEventEnvelope({
            sessionId: "session_1",
            seq: 2,
            event: {
              type: EventType.InputAdmitted,
              data: {
                requestId: body.requestId,
                inputId: "input_2",
                role: InputRole.User,
                content: inputFixture(
                  inputParts("follow up", [
                    {
                      ...original,
                      file: {
                        rolloutId: "session_1",
                        path: "attachments/requests/queued/1.png",
                      },
                    },
                  ]),
                ),
              },
            },
          }),
        }
      }
      if (method === "session/list") return { sessions: [] }
      return notFound()
    }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: inputParts("follow up", [original]),

      execution: { ...createExecutionViewState(), activeTurnId: "turn_1" },
    })

    await useAppStore.getState().admitInput(inputParts("follow up", [original]))

    expect(fakeRef.current.requestsFor("session/input/steer")).toHaveLength(1)
    expect(fakeRef.current.requestsFor("session/input/queue")).toHaveLength(1)
    expect(
      fakeRef.current.requestsFor("session/input/queue")[0]?.params,
    ).toMatchObject({
      content: inputFixture(inputParts("follow up", [original])),
    })
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(0)
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    expect(useAppStore.getState().message).toBeUndefined()
  })

  it("clears pending admission recovery only when the durable event confirms the write", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({
      modelSelections: {
        session_1: { provider: "openai", model: "gpt-5.1-codex" },
      },
    })
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])
    useAppStore.setState({ promptDraft: inputParts("hello") })

    await useAppStore.getState().admitInput(inputParts("hello"))

    const pendingAdmissions = () =>
      inputRecoveryMemory.listAdmissionsForApiBase(
        useAppStore.getState().apiBase,
      )
    expect(useAppStore.getState().message).toBeUndefined()
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1)
    // The response acknowledges the routing decision only; the outbox entry
    // is still held.
    expect(pendingAdmissions()).toHaveLength(1)

    const requestId = (
      fakeRef.current.requestsFor("session/input")[0]?.params as {
        requestId: string
      }
    ).requestId
    fakeRef.current.streams[0]?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId,
            inputId: "input_1",
            role: InputRole.User,
            content: inputFixture(inputParts("hello")),
          },
        },
      }),
    )

    await vi.waitFor(() => expect(pendingAdmissions()).toHaveLength(0))
  })

  it("acknowledges a queued request from the queue write", async () => {
    let items: Array<{
      id: string
      sessionId: string
      input: { submissionId: string; content: InputContent }
      createdAt: string
    }> = []
    fakeRef.current.respond = (method, params) => {
      if (method === "session/queue/list") return { items }
      if (method === "session/input/queue") {
        const body = params as { requestId: string }
        items = [
          {
            id: "input_queued",
            sessionId: "session_1",
            input: {
              submissionId: body.requestId,
              content: inputFixture(inputParts("run later")),
            },
            createdAt: sessionDetail.createdAt,
          },
        ]
        return {
          content: requestedInputContent(body.requestId),
          requestId: body.requestId,
          turnId: body.requestId,
          inputId: "input_queued",
        }
      }
      return notFound()
    }
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])
    fakeRef.current.streams[0]?.emitReplayComplete()
    useAppStore.setState({ promptDraft: inputParts("run later") })
    await useAppStore.getState().admitInput(inputParts("run later"), "queue")
    expect(
      inputRecoveryMemory.listAdmissionsForApiBase(
        useAppStore.getState().apiBase,
      ),
    ).toEqual([])
    expect(useAppStore.getState().queuedItems.map((item) => item.id)).toEqual([
      "input_queued",
    ])
    expect(
      projectExecutionView(useAppStore.getState().execution).entries,
    ).toEqual([])
  })

  it("restores a prompt rejected before its durable input event", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({
      modelSelections: {
        session_1: { provider: "openai", model: "gpt-5.1-codex" },
      },
    })
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])
    fakeRef.current.streams[0]?.emitReplayComplete()
    useAppStore.setState({ promptDraft: inputParts("Please review this") })

    await useAppStore.getState().admitInput(inputParts("Please review this"))
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    const requestId = (
      fakeRef.current.requestsFor("session/input")[0]?.params as {
        requestId: string
      }
    ).requestId
    fakeRef.current.streams[0]?.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.TurnCompleted,
          data: { turnId: requestId, outcome: { status: "completed" } },
        },
      }),
    )

    await vi.waitFor(() =>
      expect(useAppStore.getState().promptDraft).toEqual(
        inputParts("Please review this"),
      ),
    )
    await vi.waitFor(() =>
      expect(
        inputRecoveryMemory.listAdmissionsForApiBase(
          useAppStore.getState().apiBase,
        ),
      ).toHaveLength(1),
    )
  })

  it("restores an unconfirmed submission and its attachments within the app", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = admissionResponder(() =>
      inputFixture(inputParts("recover after reload", [promoted])),
    )
    const attachment = {
      name: "screen.png",
      mediaType: "image/png" as const,
      detail: "high" as const,
      sizeBytes: 9,
      file: {
        rolloutId: "session_1",
        path: "attachments/staging/draft_reload/1.png",
      },
    }
    const promoted = {
      ...attachment,
      file: {
        rolloutId: "session_1",
        path: "attachments/requests/draft_reload/1.png",
      },
    }
    useAppStore.setState({
      modelSelections: {
        session_1: { provider: "openai", model: "gpt-5.1-codex" },
      },
    })
    await useAppStore.getState().selectSession("session_1")
    emitSnapshot(fakeRef.current.streams[0])
    useAppStore.setState({
      promptDraft: inputParts("recover after reload", [attachment]),
    })
    await useAppStore
      .getState()
      .admitInput(inputParts("recover after reload", [attachment]))
    expect(useAppStore.getState().promptDraft).toBeUndefined()

    useAppStore.getState().stream?.close()
    useAppStore.setState({
      ...createInitialAppState(),
      apiBase: "http://api.test",
    })
    await useAppStore.getState().selectSession("session_1")
    const replay = fakeRef.current.streams.at(-1)
    emitSnapshot(replay)
    replay?.emitReplayComplete()

    await vi.waitFor(() =>
      expect(useAppStore.getState().promptDraft).toEqual(
        inputParts("recover after reload", [promoted]),
      ),
    )
    expect(
      (useAppStore.getState().promptDraft?.attachments ?? []).filter(
        (attachment) => attachment.mediaType !== "application/pdf",
      ),
    ).toEqual(inputParts("", [promoted]).attachments)
  })

  it("preserves promoted attachment ownership in drafts parked during admission", async () => {
    const original = {
      name: "screen.png",
      mediaType: "image/png" as const,
      sizeBytes: 9,
      file: {
        rolloutId: "draft_parked",
        path: "attachments/staging/parked/1.png",
      },
    }
    const promoted = {
      ...original,
      file: {
        rolloutId: "session_1",
        path: "attachments/requests/parked/1.png",
      },
    }
    const response = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "session/input") return response.promise
      return notFound()
    }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: inputParts("first message", [original]),
    })
    const submission = useAppStore
      .getState()
      .admitInput(inputParts("first message", [original]))
    useAppStore
      .getState()
      .setPromptDraft(inputParts("next message", [original]))
    await useAppStore.getState().selectSession("session_2")
    const request = fakeRef.current.requestsFor("session/input")[0]?.params as {
      requestId: string
    }
    response.resolve({
      requestId: request.requestId,
      content: inputFixture(inputParts("first message", [promoted])),
    })
    await submission
    await useAppStore.getState().selectSession("session_1")
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("next message", [promoted]),
    )
  })

  it("clears an attachment-only draft after admission", async () => {
    globalThis.localStorage.clear()
    fakeRef.current.respond = admissionResponder(() =>
      inputFixture(inputParts("", [promoted])),
    )
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
    const promoted = {
      ...attachment,
      file: {
        rolloutId: "session_1",
        path: "attachments/requests/input_only/1.png",
      },
    }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: inputParts("", [attachment]),
    })

    await useAppStore.getState().admitInput(inputParts("", [attachment]))

    expect(
      (useAppStore.getState().promptDraft?.attachments ?? []).filter(
        (attachment) => attachment.mediaType !== "application/pdf",
      ),
    ).toEqual(inputParts("").attachments)
  })

  it.each([
    "requires_login",
    "catalog_error",
    "missing",
  ])("keeps an explicit ChatGPT account on admission when it is %s", async (failure) => {
    fakeRef.current.respond = admissionResponder()
    const selected = { provider: "chatgpt-personal", model: "account-model" }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      modelSelections: { session_1: selected },
      defaultProvider: "openai",
      defaultModel: "paid-model",
      userPreference: { provider: "openai", model: "paid-model" },
      providers: [
        ...(failure === "missing"
          ? []
          : [
              {
                name: "chatgpt-personal",
                availability:
                  failure === "requires_login"
                    ? ("requires_login" as const)
                    : ("available" as const),
                models: [],
                ...(failure === "catalog_error"
                  ? { catalogError: "Unavailable" }
                  : {}),
              },
            ]),
        {
          name: "openai",
          models: [
            {
              id: "paid-model",
              displayName: "Paid model",
              instructionProfileId: "default",
            },
          ],
        },
      ],
    })
    await useAppStore.getState().admitInput(inputParts("keep this account"))
    expect(
      fakeRef.current.requestsFor("session/input")[0]?.params,
    ).toMatchObject({ modelSelection: selected })
    expect(useAppStore.getState().modelSelections.session_1).toEqual(selected)
  })

  it("uses a picker choice immediately for the pill, admission, and user preference", async () => {
    globalThis.localStorage.clear()
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

    await useAppStore.getState().admitInput(inputParts("hello"))

    const params = fakeRef.current.requests.map((request) => request.params)
    expect(params).toContainEqual(picked)
    expect(params).toContainEqual(
      expect.objectContaining({ modelSelection: picked }),
    )
  })

  it("persists a draft model choice before a session has been created", async () => {
    fakeRef.current.respond = admissionResponder()
    useAppStore.setState({
      userPreference: { provider: "removed-account", model: "retired-model" },
    })
    const picked = { provider: "faux", model: "scripted" }
    useAppStore.getState().setModelSelection(undefined, picked)
    expect(useAppStore.getState().draftModelSelection).toEqual(picked)
    await vi.waitFor(() =>
      expect(useAppStore.getState().userPreference).toEqual(picked),
    )
    expect(fakeRef.current.requestsFor("userPreference/write")).toEqual([
      { method: "userPreference/write", params: picked },
    ])
    expect(fakeRef.current.requestsFor("session/create")).toEqual([])
  })

  it("restores old session current from its last turn without leaking across sessions", async () => {
    globalThis.localStorage.clear()
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
        globalThis.localStorage.getItem("yakitori.modelSelections") ?? "{}",
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
    globalThis.localStorage.clear()
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
    await useAppStore.getState().admitInput(inputParts("restored"))

    const admissions = fakeRef.current.requestsFor("session/input")
    expect(admissions[0]?.params).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    })
  })

  it("does not write a preference when the selected model is unchanged", async () => {
    const current = { provider: "faux", model: "scripted", effort: "low" }
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      modelSelections: { session_1: current },
    })
    useAppStore.getState().setModelSelection("session_1", { ...current })
    await Promise.resolve()
    expect(fakeRef.current.requestsFor("userPreference/write")).toEqual([])
    expect(useAppStore.getState().modelSelections.session_1).toBe(current)
  })

  it("keeps a failed preference write scoped to the current Session", async () => {
    globalThis.localStorage.clear()
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
    globalThis.localStorage.clear()
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
    globalThis.localStorage.clear()
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

    await useAppStore.getState().admitInput(inputParts("hello"))

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

function admissionResponder(acceptedContent?: () => InputContent) {
  return (method: string, params: unknown) => {
    if (method === "userPreference/write") {
      return { userPreference: params }
    }
    if (method === "session/input") {
      const body = params as { requestId: string }
      const content =
        acceptedContent?.() ?? requestedInputContent(body.requestId)
      return {
        content,
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
              content,
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

it("resumes the source event stream after an edit request fails", async () => {
  fakeRef.current.respond = (method) => {
    if (method === "session/skills") return { skills: [] }
    throw new ApiRequestError("Edit failed", "not_found")
  }
  await useAppStore.getState().selectSession("session_1")
  const first = fakeRef.current.streams[0]
  emitSnapshot(first)
  first?.emitReplayComplete()
  await useAppStore
    .getState()
    .revertSession("input_1", "edit", inputFixture(inputParts("Replacement")))
  expect(useAppStore.getState().selection.sessionId).toBe("session_1")
  expect(useAppStore.getState().message).toBe("Edit failed")
  const resumed = fakeRef.current.streams[1]
  expect(resumed?.after).toBe(1)
  resumed?.emitEvent(
    createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: "late",
          inputId: "input_late",
          role: InputRole.User,
          content: inputFixture(inputParts("Input during edit")),
        },
      },
    }),
  )
  expect(useAppStore.getState().execution.entries).toContainEqual(
    expect.objectContaining({ text: "Input during edit" }),
  )
})

describe("new session drafts", () => {
  it("opens a local draft and only focuses it when new is repeated in the same project", () => {
    useAppStore.setState({
      selection: { sessionId: "session_existing" },
      projects: [makeProject("project_a", "/p/a")],
      sessionsByProject: { project_a: { sessions: [] } },
    })
    useAppStore.getState().startNewSession("project_a")
    useAppStore.getState().setPromptDraft(inputParts("keep this"))
    const { threadId, sessionSelectionIntentRevision, composerFocusRevision } =
      useAppStore.getState()
    useAppStore.setState({
      settingsSection: "general",
      commandPanel: { kind: "status" },
    })

    useAppStore.getState().startNewSession("project_a")

    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    expect(useAppStore.getState().selectedSession).toBeUndefined()
    expect(useAppStore.getState().settingsSection).toBeUndefined()
    expect(useAppStore.getState().commandPanel).toBeUndefined()
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("keep this"))
    expect(useAppStore.getState().threadId).toBe(threadId)
    expect(useAppStore.getState().sessionSelectionIntentRevision).toBe(
      sessionSelectionIntentRevision,
    )
    expect(useAppStore.getState().composerFocusRevision).toBe(
      composerFocusRevision + 1,
    )
    expect(
      useAppStore.getState().sessionsByProject.project_a?.sessions,
    ).toEqual([])
    expect(fakeRef.current.requestsFor("session/create")).toEqual([])
  })

  it("recovers a first send interrupted before session creation", async () => {
    const creation = deferredResponse()
    fakeRef.current.respond = (method) =>
      method === "session/create" ? creation.promise : notFound()
    const attachment = {
      name: "unsent.png",
      mediaType: "image/png" as const,
      sizeBytes: 9,
      file: {
        rolloutId: "draft_new_session",
        path: "attachments/staging/draft_new_session/1.png",
      },
    }
    const promoted = {
      ...attachment,
      file: {
        rolloutId: "session_1",
        path: "attachments/requests/first_send/1.png",
      },
    }
    useAppStore.setState({
      promptDraft: inputParts("first send", [attachment]),
    })
    const sending = useAppStore
      .getState()
      .admitInput(inputParts("first send", [attachment]))
    await vi.waitFor(() =>
      expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1),
    )
    const pending = inputRecoveryMemory.listAdmissionsForApiBase(
      useAppStore.getState().apiBase,
    )
    expect(pending).toEqual([
      expect.objectContaining({
        sessionId: "draft_first_input",
        content: inputFixture(inputParts("first send", [attachment])),
      }),
    ])
    creation.reject(new ApiRequestError("Creation failed", "internal_error"))
    await sending

    useAppStore.setState({
      ...createInitialAppState(),
      apiBase: "http://api.test",
    })
    fakeRef.current.respond = (method) => {
      if (method === "provider/list")
        return {
          accounts: [],
          providers: [],
          defaultProvider: "faux",
          defaultModel: "m",
        }
      if (method === "project/list") return { projects: [] }
      if (method === "session/list") return { sessions: [] }
      if (method === "session/create")
        return {
          session: sessionDetail,
          event: createEventEnvelope({
            sessionId: "session_1",
            seq: 1,
            event: { type: EventType.SessionCreated, data: {} },
          }),
        }
      if (method === "session/input") {
        const input = fakeRef.current.requestsFor("session/input").at(-1)
          ?.params as { requestId: string }
        return {
          content: inputFixture(inputParts("first send", [promoted])),
          requestId: input.requestId,
          inputId: "input_1",
        }
      }
      return notFound()
    }
    await useAppStore.getState().boot()
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("first send", [attachment]),
    )

    await useAppStore
      .getState()
      .admitInput(inputParts("first send", [attachment]))
    const remaining = inputRecoveryMemory.listAdmissionsForApiBase(
      useAppStore.getState().apiBase,
    )
    expect(remaining).toEqual([
      expect.objectContaining({
        sessionId: "session_1",
        supersedesRequestId: pending[0]?.requestId,
      }),
    ])

    useAppStore.getState().stream?.close()
    useAppStore.setState({
      ...createInitialAppState(),
      apiBase: "http://api.test",
    })
    await useAppStore.getState().boot()
    expect(fakeRef.current.requestsFor("session/read")).toContainEqual({
      method: "session/read",
      params: { sessionId: "session_1" },
    })
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("first send", [promoted]),
    )
  })

  it("keeps the new-session draft separate from an existing session draft", async () => {
    useAppStore.getState().startNewSession()
    const newSessionThreadId = useAppStore.getState().threadId
    useAppStore.getState().setPromptDraft(inputParts("new task"))
    await useAppStore.getState().selectSession("session_1")
    useAppStore.getState().setPromptDraft(inputParts("existing task"))
    useAppStore.getState().startNewSession()
    expect(useAppStore.getState().threadId).toBe(newSessionThreadId)
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("new task"))
    await useAppStore.getState().selectSession("session_1")
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("existing task"),
    )
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(0)
  })

  it("returns to the created session after its first admission fails and retries there", async () => {
    const respond = admissionResponder()
    let rejectAdmission = true
    fakeRef.current.respond = (method, params) => {
      if (method === "session/create")
        return {
          session: sessionDetail,
          event: createEventEnvelope({
            sessionId: "session_1",
            seq: 1,
            event: { type: EventType.SessionCreated, data: {} },
          }),
        }
      if (method === "session/input" && rejectAdmission)
        throw new ApiRequestError("Input rejected", "not_found")
      return respond(method, params)
    }
    useAppStore.getState().startNewSession()
    useAppStore.getState().setPromptDraft(inputParts("keep this"))
    const threadId = useAppStore.getState().threadId
    await useAppStore.getState().admitInput(inputParts("keep this"))
    expect(useAppStore.getState().message).toBe("Input rejected")

    useAppStore.getState().startNewSession()
    expect(useAppStore.getState().selection.sessionId).toBe("session_1")
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("keep this"))
    expect(useAppStore.getState().threadId).toBe(threadId)
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)

    await useAppStore.getState().selectSession("session_existing")
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    useAppStore.getState().startNewSession()
    await vi.waitFor(() =>
      expect(useAppStore.getState().selection.sessionId).toBe("session_1"),
    )
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("keep this"))
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    expect(
      useAppStore
        .getState()
        .sessionsByProject[""]?.sessions.map((session) => session.id),
    ).toContain("session_1")

    rejectAdmission = false
    emitSnapshot(fakeRef.current.streams.at(-1))
    fakeRef.current.streams.at(-1)?.emitReplayComplete()
    await useAppStore.getState().admitInput(inputParts("keep this"))
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(2)
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    useAppStore.getState().startNewSession()
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    expect(useAppStore.getState().threadId).not.toBe(threadId)
  })

  it("creates on first admission and carries the draft model and workspace draft id", async () => {
    globalThis.localStorage.clear()
    const respond = admissionResponder()
    fakeRef.current.respond = (method, params) => {
      if (method === "session/create")
        return {
          session: sessionDetail,
          event: createEventEnvelope({
            sessionId: "session_1",
            seq: 1,
            event: { type: EventType.SessionCreated, data: {} },
          }),
        }
      return respond(method, params)
    }
    useAppStore.getState().startNewSession()
    const threadId = useAppStore.getState().threadId
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(0)
    useAppStore
      .getState()
      .setModelSelection(undefined, { provider: "faux", model: "scripted" })
    useAppStore.getState().setPromptDraft(inputParts("hello"))
    await Promise.all([
      useAppStore.getState().admitInput(inputParts("hello")),
      useAppStore.getState().admitInput(inputParts("hello")),
    ])
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1)
    expect(
      fakeRef.current.requestsFor("session/input")[0]?.params,
    ).toMatchObject({
      sessionId: "session_1",
      content: inputFixture(inputParts("hello")),
      modelSelection: { provider: "faux", model: "scripted" },
    })
    expect(useAppStore.getState().promptDraft).toBeUndefined()
    expect(useAppStore.getState().threadId).toBe(threadId)
    expect(useAppStore.getState().sessionThreadIds.session_1).toBe(threadId)
    expect(useAppStore.getState().newSessionThreadId).not.toBe(threadId)
  })

  it("keeps an unavailable ChatGPT draft account on its first admission instead of the API default", async () => {
    const respond = admissionResponder()
    fakeRef.current.respond = (method, params) =>
      method === "session/create"
        ? {
            session: sessionDetail,
            event: createEventEnvelope({
              sessionId: "session_1",
              seq: 1,
              event: { type: EventType.SessionCreated, data: {} },
            }),
          }
        : respond(method, params)
    useAppStore.setState({
      defaultProvider: "openai",
      defaultModel: "paid-model",
      userPreference: { provider: "openai", model: "paid-model" },
      providers: [
        {
          name: "chatgpt-personal",
          availability: "requires_login",
          models: [],
        },
        {
          name: "openai",
          models: [
            {
              id: "paid-model",
              displayName: "Paid model",
              instructionProfileId: "default",
            },
          ],
        },
      ],
    })
    useAppStore.getState().startNewSession()
    useAppStore.getState().setModelSelection(undefined, {
      provider: "chatgpt-personal",
      model: "account-model",
    })
    await useAppStore.getState().admitInput(inputParts("same account please"))
    expect(
      fakeRef.current.requestsFor("session/input")[0]?.params,
    ).toMatchObject({
      modelSelection: { provider: "chatgpt-personal", model: "account-model" },
    })
  })

  it("keeps first-send creation out of busy while tracking concurrent work", async () => {
    const create = deferredResponse()
    const update = deferredResponse()
    const respond = admissionResponder()
    fakeRef.current.respond = (method, params) => {
      if (method === "session/create") return create.promise
      if (method === "project/update") return update.promise
      if (method === "project/list") return { projects: [] }
      return respond(method, params)
    }
    useAppStore.getState().startNewSession()
    const sending = useAppStore.getState().admitInput(inputParts("hello"))
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    expect(useAppStore.getState().busy).toBe(false)
    const updating = useAppStore
      .getState()
      .updateProject("project_a", { name: "Renamed" })
    expect(useAppStore.getState().busy).toBe(true)
    update.resolve(undefined)
    await updating
    expect(useAppStore.getState().busy).toBe(false)
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    create.resolve({
      session: sessionDetail,
      event: createEventEnvelope({
        sessionId: "session_1",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await sending
    expect(useAppStore.getState().selection.sessionId).toBe("session_1")
    expect(useAppStore.getState().busy).toBe(false)
  })

  it("queues one captured first prompt with images, excerpts, and model during creation", async () => {
    globalThis.localStorage.clear()
    const create = deferredResponse()
    const respond = admissionResponder(() =>
      inputFixture(
        inputParts("first", [
          {
            ...image,
            file: {
              rolloutId: "session_1",
              path: "attachments/requests/captured/1.png",
            },
          },
        ]),
        { references: [excerpt] }.references,
      ),
    )
    fakeRef.current.respond = (method, params) =>
      method === "session/create" ? create.promise : respond(method, params)
    useAppStore.getState().startNewSession()
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(0)
    useAppStore
      .getState()
      .setModelSelection(undefined, { provider: "faux", model: "first" })
    const image = {
      name: "screen.png",
      mediaType: "image/png" as const,
      detail: "high" as const,
      sizeBytes: 9,
      file: {
        rolloutId: "draft_1",
        path: "attachments/staging/captured/1.png",
      },
    }
    const excerpt = {
      id: "excerpt_1",

      text: "selected context",
      source: { kind: "file" as const, label: "README", path: "/p/README" },
    }
    useAppStore.getState().setPromptDraft(inputParts("first", [image]))
    useAppStore.getState().addPromptExcerpt(excerpt)
    const first = useAppStore
      .getState()
      .admitInput(inputParts("first", [image]))
    const duplicate = useAppStore
      .getState()
      .admitInput(inputParts("first", [image]))
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    const { threadId, sessionSelectionIntentRevision, composerFocusRevision } =
      useAppStore.getState()
    useAppStore.getState().startNewSession()
    expect(useAppStore.getState().threadId).toBe(threadId)
    expect(useAppStore.getState().sessionSelectionIntentRevision).toBe(
      sessionSelectionIntentRevision,
    )
    expect(useAppStore.getState().composerFocusRevision).toBe(
      composerFocusRevision + 1,
    )
    useAppStore.getState().setPromptDraft(inputParts("next"))
    useAppStore.getState().removePromptExcerpt(excerpt.id)
    useAppStore
      .getState()
      .setModelSelection(undefined, { provider: "faux", model: "later" })
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(0)
    create.resolve({
      session: sessionDetail,
      event: createEventEnvelope({
        sessionId: "session_1",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await Promise.all([first, duplicate])
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1)
    expect(
      fakeRef.current.requestsFor("session/input")[0]?.params,
    ).toMatchObject({
      content: inputFixture(
        inputParts("first", [image]),
        { references: [excerpt] }.references,
      ),
      modelSelection: { provider: "faux", model: "first" },
    })
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("next"))
    expect(useAppStore.getState().promptExcerpts).toEqual([])
  })

  it("keeps an existing selection when a pending creation responds late", async () => {
    const create = deferredResponse()
    fakeRef.current.respond = (method) =>
      method === "session/create"
        ? create.promise
        : method === "session/delete"
          ? { sessionId: "session_1" }
          : notFound()
    useAppStore.getState().startNewSession()
    useAppStore.getState().setPromptDraft(inputParts("new conversation"))
    const first = useAppStore
      .getState()
      .admitInput(inputParts("new conversation"))
    await useAppStore.getState().selectSession("session_existing")
    create.resolve({
      session: sessionDetail,
      event: createEventEnvelope({
        sessionId: "session_1",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await first
    expect(useAppStore.getState().selection.sessionId).toBe("session_existing")
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(0)
    expect(useAppStore.getState().newSessionPrompt).toEqual(
      inputParts("new conversation"),
    )
    expect(fakeRef.current.requestsFor("session/delete")).toEqual([
      { method: "session/delete", params: { sessionId: "session_1" } },
    ])
  })

  it("starts a new draft after navigation while an earlier create is pending", async () => {
    const first = deferredResponse()
    const second = deferredResponse()
    let requests = 0
    fakeRef.current.respond = (method, params) => {
      if (method === "session/create") {
        requests += 1
        return requests === 1 ? first.promise : second.promise
      }
      if (method === "session/input")
        return {
          requestId: (params as { requestId: string }).requestId,
          inputId: "input_2",
          content: inputFixture(inputParts("second")),
        }
      if (method === "session/delete") return { sessionId: "session_1" }
      return notFound()
    }
    useAppStore.getState().startNewSession()
    const firstSend = useAppStore.getState().admitInput(inputParts("first"))
    useAppStore.getState().startNewSession()
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    await useAppStore.getState().selectSession("session_existing")
    useAppStore.getState().startNewSession()
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    useAppStore.getState().setPromptDraft(inputParts("second"))
    const secondSend = useAppStore.getState().admitInput(inputParts("second"))
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(2)
    first.resolve({
      session: sessionDetail,
      event: createEventEnvelope({
        sessionId: "session_1",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await firstSend
    expect(fakeRef.current.requestsFor("session/delete")).toEqual([
      { method: "session/delete", params: { sessionId: "session_1" } },
    ])
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    second.resolve({
      session: { ...sessionDetail, id: "session_2" },
      event: createEventEnvelope({
        sessionId: "session_2",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await secondSend
    expect(useAppStore.getState().selection.sessionId).toBe("session_2")
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1)
    expect(
      fakeRef.current.requestsFor("session/input")[0]?.params,
    ).toMatchObject({
      sessionId: "session_2",
      content: inputFixture(inputParts("second")),
    })
  })

  it("does not delete the active project when an older create responds last", async () => {
    const first = deferredResponse()
    const second = deferredResponse()
    let requests = 0
    fakeRef.current.respond = (method, params) => {
      if (method === "session/create")
        return ++requests === 1 ? first.promise : second.promise
      if (method === "session/delete") return { sessionId: "session_a" }
      if (method === "session/input")
        return {
          requestId: (params as { requestId: string }).requestId,
          inputId: "input_b",
          content: inputFixture(inputParts("work in B")),
        }
      return notFound()
    }
    useAppStore.setState({
      projects: [
        makeProject("project_a", "/p/a"),
        makeProject("project_b", "/p/b"),
      ],
    })
    useAppStore.getState().startNewSession("project_a")
    const firstSend = useAppStore.getState().admitInput(inputParts("work in A"))
    useAppStore.getState().startNewSession("project_b")
    useAppStore.getState().setPromptDraft(inputParts("work in B"))
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    const secondSend = useAppStore
      .getState()
      .admitInput(inputParts("work in B"))
    expect(fakeRef.current.requestsFor("session/create")).toEqual([
      {
        method: "session/create",
        params: { projectId: "project_a", workingDirectory: "/p/a" },
      },
      {
        method: "session/create",
        params: { projectId: "project_b", workingDirectory: "/p/b" },
      },
    ])
    second.resolve({
      session: { ...sessionDetail, id: "session_b", projectId: "project_b" },
      event: createEventEnvelope({
        sessionId: "session_b",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await secondSend
    expect(useAppStore.getState().selection.sessionId).toBe("session_b")
    first.resolve({
      session: { ...sessionDetail, id: "session_a", projectId: "project_a" },
      event: createEventEnvelope({
        sessionId: "session_a",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await firstSend
    expect(fakeRef.current.requestsFor("session/delete")).toEqual([
      { method: "session/delete", params: { sessionId: "session_a" } },
    ])
    expect(useAppStore.getState().selection.sessionId).toBe("session_b")
    expect(useAppStore.getState().selectedSession?.projectId).toBe("project_b")
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1)
  })

  it("reports a failed cleanup for an abandoned successful create", async () => {
    const create = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === "session/create") return create.promise
      if (method === "session/delete")
        throw new ApiRequestError("Deletion failed", "not_found")
      return notFound()
    }
    useAppStore.getState().startNewSession()
    const sending = useAppStore.getState().admitInput(inputParts("abandoned"))
    await useAppStore.getState().selectSession("session_existing")
    create.resolve({
      session: sessionDetail,
      event: createEventEnvelope({
        sessionId: "session_1",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await sending
    expect(useAppStore.getState().message).toBe(
      "Could not remove abandoned conversation session_1: Deletion failed",
    )
    expect(useAppStore.getState().selection.sessionId).toBe("session_existing")
  })

  it("changes an unsent draft's project locally and creates in the current project on first send", async () => {
    const create = deferredResponse()
    const respond = admissionResponder(() =>
      inputFixture(
        inputParts("work in B", [
          {
            ...attachment,
            file: {
              rolloutId: "session_1",
              path: "attachments/requests/project_b/1.png",
            },
          },
        ]),
      ),
    )
    fakeRef.current.respond = (method, params) => {
      if (method === "session/create") return create.promise
      return respond(method, params)
    }
    useAppStore.setState({
      projects: [
        makeProject("project_a", "/p/a"),
        makeProject("project_b", "/p/b"),
      ],
    })
    useAppStore.getState().startNewSession("project_a")
    const attachment = {
      name: "screen.png",
      mediaType: "image/png" as const,
      detail: "high" as const,
      sizeBytes: 9,
      file: { rolloutId: "draft_1", path: "attachments/staging/1.png" },
    }
    useAppStore.getState().setPromptDraft(inputParts("work in B", [attachment]))
    useAppStore
      .getState()
      .setModelSelection(undefined, { provider: "faux", model: "scripted" })
    const threadId = useAppStore.getState().threadId
    const revision = useAppStore.getState().sessionSelectionIntentRevision
    useAppStore.getState().setNewSessionProject("project_b")
    expect(
      useAppStore.getState().sessionSelectionIntentRevision,
    ).toBeGreaterThan(revision)
    expect(useAppStore.getState().selection.sessionId).toBeUndefined()
    expect(useAppStore.getState().currentProject).toBe("project_b")
    expect(useAppStore.getState().threadId).toBe(threadId)
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("work in B", [attachment]),
    )
    expect(useAppStore.getState().draftModelSelection).toEqual({
      provider: "faux",
      model: "scripted",
    })
    expect(fakeRef.current.requestsFor("session/create")).toEqual([])
    expect(fakeRef.current.requestsFor("session/delete")).toEqual([])

    const sending = useAppStore
      .getState()
      .admitInput(inputParts("work in B", [attachment]))
    expect(fakeRef.current.requestsFor("session/create")).toEqual([
      {
        method: "session/create",
        params: { projectId: "project_b", workingDirectory: "/p/b" },
      },
    ])
    create.resolve({
      session: { ...sessionDetail, projectId: "project_b" },
      event: createEventEnvelope({
        sessionId: "session_1",
        seq: 1,
        event: { type: EventType.SessionCreated, data: {} },
      }),
    })
    await sending
    expect(useAppStore.getState().selection.sessionId).toBe("session_1")
    expect(useAppStore.getState().currentProject).toBe("project_b")
    expect(useAppStore.getState().selectedSession?.projectId).toBe("project_b")
    expect(useAppStore.getState().threadId).toBe(threadId)
    expect(
      fakeRef.current.requestsFor("session/input")[0]?.params,
    ).toMatchObject({
      content: inputFixture(inputParts("work in B", [attachment])),
      modelSelection: { provider: "faux", model: "scripted" },
    })
    expect(useAppStore.getState().promptDraft).toBeUndefined()
  })

  it("retains the queued draft on creation failure and permits retry", async () => {
    const create = deferredResponse()
    const respond = admissionResponder()
    fakeRef.current.respond = (method, params) =>
      method === "session/create" ? create.promise : respond(method, params)
    useAppStore.getState().startNewSession()
    const first = useAppStore.getState().admitInput(inputParts("try again"))
    const duplicate = useAppStore.getState().admitInput(inputParts("try again"))
    create.reject(new ApiRequestError("Creation failed", "not_found"))
    await Promise.all([first, duplicate])
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("try again"))
    expect(useAppStore.getState().message).toBe("Creation failed")
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1)
    fakeRef.current.respond = (method, params) =>
      method === "session/create"
        ? {
            session: sessionDetail,
            event: createEventEnvelope({
              sessionId: "session_1",
              seq: 1,
              event: { type: EventType.SessionCreated, data: {} },
            }),
          }
        : respond(method, params)
    await useAppStore.getState().admitInput(inputParts("try again"))
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(2)
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1)
  })

  it("keeps the admitted session when an earlier session list returns empty", async () => {
    const list = deferredResponse()
    const sidebar = deferredResponse()
    const created = { ...sessionDetail, projectId: "project_a" }
    const respond = admissionResponder()
    const request = fakeRef.current.request.bind(fakeRef.current)
    // Hold the post-admission refresh so only the pre-creation reads can settle.
    const requests = vi
      .spyOn(fakeRef.current, "request")
      .mockImplementation((method, params) =>
        method === "sidebar/read" ? sidebar.promise : request(method, params),
      )
    fakeRef.current.respond = (method, params) => {
      if (method === "session/create")
        return {
          session: created,
          event: createEventEnvelope({
            sessionId: "session_1",
            seq: 1,
            event: { type: EventType.SessionCreated, data: {} },
          }),
        }
      if (method === "session/list")
        return fakeRef.current.requestsFor(method).length <= 2
          ? list.promise
          : { sessions: [created] }
      return respond(method, params)
    }
    useAppStore.setState({ projects: [makeProject("project_a", "/p/a")] })
    useAppStore.getState().startNewSession("project_a")
    const loading = Promise.all([
      useAppStore.getState().loadSessions(undefined),
      useAppStore.getState().loadSessions("project_a"),
    ])

    try {
      await useAppStore.getState().admitInput(inputParts("hello"))
      expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1)
      expect(fakeRef.current.requestsFor("session/list")).toHaveLength(2)
      expect(useAppStore.getState().selection.sessionId).toBe("session_1")
      expect(useAppStore.getState().unsentSessionByProject).toEqual({})
      for (const key of ["", "project_a"]) {
        expect(
          useAppStore
            .getState()
            .sessionsByProject[key]?.sessions.map(({ id }) => id),
        ).toEqual(["session_1"])
        expect(useAppStore.getState().sessionsByProject[key]?.loading).toBe(
          false,
        )
      }

      list.resolve({ sessions: [] })
      await loading

      for (const key of ["", "project_a"]) {
        expect(
          useAppStore
            .getState()
            .sessionsByProject[key]?.sessions.map(({ id }) => id),
        ).toEqual(["session_1"])
        expect(useAppStore.getState().sessionsByProject[key]?.loading).toBe(
          false,
        )
      }
    } finally {
      list.resolve({ sessions: [] })
      sidebar.resolve({ sections: [], entries: {} })
      await loading
      requests.mockRestore()
    }
  })

  it("keeps a first-send row until the durable session index publishes it", async () => {
    const respond = admissionResponder()
    let listedSessions: readonly ApiSessionDetail[] = []
    fakeRef.current.respond = (method, params) => {
      if (method === "session/create")
        return {
          session: sessionDetail,
          event: createEventEnvelope({
            sessionId: sessionDetail.id,
            seq: 1,
            event: { type: EventType.SessionCreated, data: {} },
          }),
        }
      if (method === "session/list") return { sessions: listedSessions }
      return respond(method, params)
    }
    useAppStore.getState().startNewSession()
    await useAppStore.getState().admitInput(inputParts("first send"))
    expect(useAppStore.getState().unsentSessionByProject).toEqual({})
    await useAppStore.getState().loadSessions(undefined)
    expect(
      useAppStore
        .getState()
        .sessionsByProject[""]?.sessions.map(({ id }) => id),
    ).toEqual([sessionDetail.id])

    listedSessions = [sessionDetail]
    await useAppStore.getState().loadSessions(undefined)
    expect(useAppStore.getState().sessionsByProject[""]?.sessions).toHaveLength(
      1,
    )

    // Once publication is observed, ordinary list updates own membership.
    listedSessions = []
    await useAppStore.getState().loadSessions(undefined)
    expect(useAppStore.getState().sessionsByProject[""]?.sessions).toEqual([])
  })

  it("keeps draft edits made during first-send creation when boot recovery finishes late", async () => {
    const list = deferredResponse()
    const create = deferredResponse()
    const respond = admissionResponder()
    fakeRef.current.respond = (method, params) => {
      if (method === "provider/list")
        return {
          accounts: [],
          providers: [],
          defaultProvider: "faux",
          defaultModel: "scripted",
        }
      if (method === "project/list") return { projects: [] }
      if (method === "sidebar/read") return { sections: [], entries: {} }
      if (method === "session/list")
        return fakeRef.current.requestsFor(method).length === 1
          ? list.promise
          : { sessions: [sessionDetail] }
      if (method === "session/create") return create.promise
      return respond(method, params)
    }
    const booting = useAppStore.getState().boot()
    await vi.waitFor(() =>
      expect(fakeRef.current.requestsFor("session/list")).toHaveLength(1),
    )
    useAppStore.getState().startNewSession()
    useAppStore.getState().setPromptDraft(inputParts("first"))
    const sending = useAppStore.getState().admitInput(inputParts("first"))
    useAppStore.getState().setPromptDraft(inputParts("next"))

    try {
      list.resolve({ sessions: [] })
      await booting
      expect(useAppStore.getState().promptDraft).toEqual(inputParts("next"))
      expect(fakeRef.current.requestsFor("session/input")).toHaveLength(0)
    } finally {
      create.resolve({
        session: sessionDetail,
        event: createEventEnvelope({
          sessionId: "session_1",
          seq: 1,
          event: { type: EventType.SessionCreated, data: {} },
        }),
      })
      await sending
    }
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("next"))
    expect(
      fakeRef.current.requestsFor("session/input")[0]?.params,
    ).toMatchObject({ content: inputFixture(inputParts("first")) })
  })

  it("reveals a search result in its collapsed project without duplicating later pagination", async () => {
    const found = {
      ...sessionDetail,
      id: "session_found",
      projectId: "project_a",
    }
    fakeRef.current.respond = (method) =>
      method === "session/list" ? { sessions: [found] } : notFound()
    useAppStore.setState({ collapsedProjects: { project_a: true } })
    await useAppStore.getState().selectSession(found.id, found)
    expect(useAppStore.getState().currentProject).toBe("project_a")
    expect(useAppStore.getState().collapsedProjects.project_a).toBeUndefined()
    await useAppStore.getState().loadSessions("project_a", { append: true })
    expect(
      useAppStore
        .getState()
        .sessionsByProject.project_a?.sessions.map((entry) => entry.id),
    ).toEqual(["session_found"])
  })
})

it("preserves draft edits made while the first session is being created", async () => {
  globalThis.localStorage.clear()
  let release: () => void = () => {
    throw new Error("Creation has not started")
  }
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const respond = admissionResponder()
  fakeRef.current.respond = async (method, params) => {
    if (method === "session/create") {
      await waiting
      return {
        session: sessionDetail,
        event: createEventEnvelope({
          sessionId: "session_1",
          seq: 1,
          event: { type: EventType.SessionCreated, data: {} },
        }),
      }
    }
    return respond(method, params)
  }
  useAppStore.getState().startNewSession()
  useAppStore.getState().setPromptDraft(inputParts("hello"))
  const sending = useAppStore.getState().admitInput(inputParts("hello"))
  await vi.waitFor(() =>
    expect(fakeRef.current.requestsFor("session/create")).toHaveLength(1),
  )
  useAppStore
    .getState()
    .setPromptDraft(inputParts("hello with another thought"))
  release()
  await sending
  expect(useAppStore.getState().promptDraft).toEqual(
    inputParts("hello with another thought"),
  )
  expect(fakeRef.current.requestsFor("session/input")[0]?.params).toMatchObject(
    { content: inputFixture(inputParts("hello")) },
  )
})

it("reveals a grouped search result in its section without inserting it into the project list", async () => {
  const found = {
    ...sessionDetail,
    id: "session_found",
    projectId: "project_a",
    sectionId: "section_work",
  }
  fakeRef.current.respond = () => notFound()
  useAppStore.setState({
    collapsedSections: { section_work: true },
    sessionsByProject: { project_a: { sessions: [] } },
  })
  await useAppStore.getState().selectSession(found.id, found)
  expect(useAppStore.getState().collapsedSections.section_work).toBeUndefined()
  expect(useAppStore.getState().sessionsByProject.project_a?.sessions).toEqual(
    [],
  )
  expect(
    useAppStore
      .getState()
      .sessionsByProject["sidebar:section:section_work"]?.sessions.map(
        (s) => s.id,
      ),
  ).toEqual(["session_found"])
  expect(useAppStore.getState().currentProject).toBe("project_a")
})

it("keeps an explicit fork independent from its source when merging session pages", async () => {
  const fork = {
    ...sessionDetail,
    id: "session_fork",
    parentSessionId: sessionDetail.id,
  }
  fakeRef.current.respond = (method) =>
    method === "session/list" ? { sessions: [fork] } : notFound()
  useAppStore.setState({
    sessionsByProject: { "": { sessions: [sessionDetail] } },
  })
  await useAppStore.getState().loadSessions(undefined, { append: true })
  expect(
    useAppStore
      .getState()
      .sessionsByProject[""]?.sessions.map((session) => session.id),
  ).toEqual(["session_1", "session_fork"])
  await useAppStore.getState().selectSession(sessionDetail.id)
  useAppStore.getState().setPromptDraft(inputParts("source draft"))
  await useAppStore.getState().selectSession(fork.id)
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(useAppStore.getState().threadId).toBe(fork.id)
  await useAppStore.getState().selectSession(sessionDetail.id)
  expect(useAppStore.getState().promptDraft).toEqual(inputParts("source draft"))
})

it("moves a session into pinned before persistence completes", async () => {
  const gate = deferredResponse()
  const session = { ...sessionDetail, projectId: "project_a" }
  const pinnedSidebar = {
    sections: [],
    entries: {
      session_1: { sectionId: "pinned", sectionPosition: 7_000_000 },
    },
  }
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") return gate.promise
    return notFound()
  }
  useAppStore.setState({
    sidebar: { sections: [], entries: {} },
    sessionsByProject: {
      project_a: { sessions: [session] },
      "sidebar:section:pinned": { sessions: [] },
    },
  })

  const pinning = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: session.id,
    sectionId: "pinned",
  })
  await Promise.resolve()

  expect(fakeRef.current.requestsFor("sidebar/update")).toHaveLength(1)
  expect(useAppStore.getState().sessionsByProject.project_a?.sessions).toEqual(
    [],
  )
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions,
  ).toEqual([expect.objectContaining({ id: session.id, sectionId: "pinned" })])

  gate.resolve(pinnedSidebar)
  expect(await pinning).toBe(true)
  expect(fakeRef.current.requestsFor("session/list")).toHaveLength(0)
  expect(
    useAppStore.getState().sidebar.entries.session_1?.sectionPosition,
  ).toBe(7_000_000)
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions[0]?.sectionPosition,
  ).toBe(7_000_000)
})

it("projects rich sidebar notifications without refetching session lists", async () => {
  fakeRef.current.respond = (method) => {
    if (method === "provider/list") {
      return {
        accounts: [],
        providers: [],
        defaultProvider: "faux",
        defaultModel: "m",
      }
    }
    if (method === "project/list") return { projects: [] }
    if (method === "session/list") return { sessions: [] }
    return notFound()
  }
  await useAppStore.getState().boot()
  const session = { ...sessionDetail, projectId: "project_a" }
  useAppStore.setState({
    sidebar: { sections: [], entries: {} },
    sessionsByProject: {
      project_a: { sessions: [session] },
      "sidebar:section:pinned": { sessions: [] },
    },
  })
  fakeRef.current.requests.length = 0

  fakeRef.current.emitSidebarChanged({
    sessionId: session.id,
    sidebar: {
      sections: [],
      entries: {
        session_1: { sectionId: "pinned", sectionPosition: 1_000_000 },
      },
    },
  })

  expect(useAppStore.getState().sessionsByProject.project_a?.sessions).toEqual(
    [],
  )
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions[0]?.id,
  ).toBe(session.id)
  expect(fakeRef.current.requestsFor("session/list")).toHaveLength(0)
})

it("keeps a pin confirmed by notification when its response is lost", async () => {
  const gate = deferredResponse()
  fakeRef.current.respond = (method) => {
    if (method === "provider/list") {
      return {
        accounts: [],
        providers: [],
        defaultProvider: "faux",
        defaultModel: "m",
      }
    }
    if (method === "project/list") return { projects: [] }
    if (method === "session/list") return { sessions: [] }
    if (method === "sidebar/update") return gate.promise
    return notFound()
  }
  await useAppStore.getState().boot()
  const session = { ...sessionDetail, projectId: "project_a" }
  useAppStore.setState({
    sidebar: { sections: [], entries: {} },
    sessionsByProject: {
      project_a: { sessions: [session] },
      "sidebar:section:pinned": { sessions: [] },
    },
  })
  fakeRef.current.requests.length = 0

  const pinning = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: session.id,
    sectionId: "pinned",
  })
  await Promise.resolve()
  const sidebar = {
    sections: [],
    entries: {
      session_1: { sectionId: "pinned", sectionPosition: 1_000_000 },
    },
  }
  fakeRef.current.emitSidebarChanged({ sessionId: session.id, sidebar })
  gate.reject(new ApiRequestError("Connection lost.", "internal_error"))

  expect(await pinning).toBe(true)
  expect(useAppStore.getState().message).toBeUndefined()
  expect(useAppStore.getState().sidebar).toEqual(sidebar)
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions[0]?.id,
  ).toBe(session.id)
  expect(fakeRef.current.requestsFor("session/list")).toHaveLength(0)
})

it("keeps a newer external section when local pin persistence fails", async () => {
  const gate = deferredResponse()
  fakeRef.current.respond = (method) => {
    if (method === "provider/list") {
      return {
        accounts: [],
        providers: [],
        defaultProvider: "faux",
        defaultModel: "m",
      }
    }
    if (method === "project/list") return { projects: [] }
    if (method === "session/list") return { sessions: [] }
    if (method === "sidebar/update") return gate.promise
    return notFound()
  }
  await useAppStore.getState().boot()
  const session = { ...sessionDetail, projectId: "project_a" }
  useAppStore.setState({
    sidebar: { sections: [{ id: "work", name: "Work" }], entries: {} },
    sessionsByProject: {
      project_a: { sessions: [session] },
      "sidebar:section:pinned": { sessions: [] },
      "sidebar:section:work": { sessions: [] },
    },
  })

  const pinning = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: session.id,
    sectionId: "pinned",
  })
  await Promise.resolve()
  const movedElsewhere = {
    sections: [{ id: "work", name: "Work" }],
    entries: {
      session_1: { sectionId: "work", sectionPosition: 1_000_000 },
    },
  }
  fakeRef.current.emitSidebarChanged({
    sessionId: session.id,
    sidebar: movedElsewhere,
  })
  gate.reject(new ApiRequestError("Could not save.", "internal_error"))

  expect(await pinning).toBe(false)
  expect(useAppStore.getState().sidebar).toEqual(movedElsewhere)
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:work"]
      ?.sessions[0]?.id,
  ).toBe(session.id)
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions,
  ).toEqual([])
})

it("does not let an older session-list response overwrite a pin", async () => {
  const stalePinnedList = deferredResponse()
  const session = { ...sessionDetail, projectId: "project_a" }
  const sidebar = {
    sections: [],
    entries: {
      session_1: { sectionId: "pinned", sectionPosition: 1_000_000 },
    },
  }
  fakeRef.current.respond = (method) => {
    if (method === "session/list") return stalePinnedList.promise
    if (method === "sidebar/update") return sidebar
    return notFound()
  }
  useAppStore.setState({
    sidebar: { sections: [], entries: {} },
    sessionsByProject: {
      project_a: { sessions: [session] },
      "sidebar:section:pinned": { sessions: [] },
    },
  })
  const staleRead = useAppStore
    .getState()
    .loadSessions(undefined, { sectionId: "pinned" })

  const pinning = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: session.id,
    sectionId: "pinned",
  })
  expect(await pinning).toBe(true)
  stalePinnedList.resolve({ sessions: [] })
  expect(await staleRead).toBe(false)

  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions[0]?.id,
  ).toBe(session.id)
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]?.loading,
  ).toBeUndefined()
})

it("keeps a newly pinned session beyond an already loaded page cursor", async () => {
  const session = { ...sessionDetail, projectId: "project_a" }
  const existing = {
    ...sessionDetail,
    id: "session_2",
    sectionId: "pinned",
    sectionPosition: 1_000_000,
  }
  const sidebar = {
    sections: [],
    entries: {
      session_1: { sectionId: "pinned", sectionPosition: 2_000_000 },
      session_2: { sectionId: "pinned", sectionPosition: 1_000_000 },
    },
  }
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") return sidebar
    return notFound()
  }
  useAppStore.setState({
    sidebar: {
      sections: [],
      entries: {
        session_2: { sectionId: "pinned", sectionPosition: 1_000_000 },
      },
    },
    sessionsByProject: {
      project_a: { sessions: [session] },
      "sidebar:section:pinned": {
        sessions: [existing],
        nextCursor: "opaque-server-cursor",
      },
    },
  })

  expect(
    await useAppStore.getState().changeSidebar({
      type: "session",
      sessionId: session.id,
      sectionId: "pinned",
    }),
  ).toBe(true)

  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions,
  ).toEqual([expect.objectContaining({ id: existing.id })])
  expect(useAppStore.getState().sessionsByProject.project_a?.sessions).toEqual(
    [],
  )
})

it("drops the page anchor after it moves beyond its old cursor", async () => {
  const moved = {
    ...sessionDetail,
    sectionId: "pinned",
    sectionPosition: 1_000_000,
  }
  const preceding = {
    ...sessionDetail,
    id: "session_2",
    sectionId: "pinned",
    sectionPosition: 500_000,
  }
  const sidebar = {
    sections: [],
    entries: {
      session_1: { sectionId: "pinned", sectionPosition: 2_000_000 },
      session_2: { sectionId: "pinned", sectionPosition: 500_000 },
    },
  }
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") return sidebar
    return notFound()
  }
  useAppStore.setState({
    sidebar: {
      sections: [],
      entries: {
        session_1: { sectionId: "pinned", sectionPosition: 1_000_000 },
        session_2: { sectionId: "pinned", sectionPosition: 500_000 },
      },
    },
    sessionsByProject: {
      "sidebar:section:pinned": {
        sessions: [preceding, moved],
        nextCursor: "opaque-server-cursor",
      },
    },
  })

  expect(
    await useAppStore.getState().changeSidebar({
      type: "move-session",
      sessionId: moved.id,
      sectionId: "pinned",
    }),
  ).toBe(true)

  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions,
  ).toEqual([expect.objectContaining({ id: preceding.id })])
})

it("moves a session out of pinned before persistence completes", async () => {
  const gate = deferredResponse()
  const session = {
    ...sessionDetail,
    projectId: "project_a",
    sectionId: "pinned",
    sectionPosition: 1_000_000,
  }
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") return gate.promise
    return notFound()
  }
  useAppStore.setState({
    sidebar: {
      sections: [],
      entries: {
        session_1: { sectionId: "pinned", sectionPosition: 1_000_000 },
      },
    },
    sessionsByProject: {
      project_a: { sessions: [] },
      "sidebar:section:pinned": { sessions: [session] },
    },
  })

  const unpinning = useAppStore.getState().changeSidebar({
    type: "move-session",
    sessionId: session.id,
    sectionId: null,
  })
  await Promise.resolve()

  expect(fakeRef.current.requestsFor("sidebar/update")).toHaveLength(1)
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions,
  ).toEqual([])
  const unpinned =
    useAppStore.getState().sessionsByProject.project_a?.sessions[0]
  expect(unpinned?.id).toBe(session.id)
  expect(unpinned?.sectionId).toBeUndefined()
  expect(unpinned?.sectionPosition).toBeUndefined()

  gate.resolve({ sections: [], entries: { session_1: {} } })
  expect(await unpinning).toBe(true)
  expect(fakeRef.current.requestsFor("session/list")).toHaveLength(0)
})

it("restores an unpinned session when pin persistence fails", async () => {
  const gate = deferredResponse()
  const session = { ...sessionDetail, projectId: "project_a" }
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") return gate.promise
    return notFound()
  }
  useAppStore.setState({
    sidebar: { sections: [], entries: {} },
    sessionsByProject: {
      project_a: { sessions: [session] },
      "sidebar:section:pinned": { sessions: [] },
    },
  })

  const pinning = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: session.id,
    sectionId: "pinned",
  })
  await Promise.resolve()
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions[0]?.id,
  ).toBe(session.id)
  useAppStore.setState((state) => ({
    sidebar: {
      ...state.sidebar,
      entries: {
        ...state.sidebar.entries,
        session_1: {
          ...state.sidebar.entries.session_1,
          title: "Renamed elsewhere",
        },
      },
    },
  }))
  gate.reject(new ApiRequestError("Could not save.", "internal_error"))

  expect(await pinning).toBe(false)
  expect(
    useAppStore.getState().sessionsByProject.project_a?.sessions[0],
  ).toMatchObject({
    id: session.id,
    title: "Renamed elsewhere",
  })
  expect(
    useAppStore.getState().sessionsByProject.project_a?.sessions[0]?.sectionId,
  ).toBeUndefined()
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions,
  ).toEqual([])
  expect(useAppStore.getState().sidebar.entries.session_1).toEqual({
    title: "Renamed elsewhere",
  })
  expect(
    useAppStore.getState().sessionsByProject.project_a?.sessions[0]?.title,
  ).toBe("Renamed elsewhere")
  expect(useAppStore.getState().message).toBe("Could not save.")
})

it("clears removed section membership from every loaded list without refetching", async () => {
  const archived = { ...sessionDetail, archived: true, sectionId: "pinned" }
  useAppStore.setState({
    selectedSession: archived,
    selection: { sessionId: archived.id },
    sessionsByProject: {
      "sidebar:section:pinned": { sessions: [archived] },
      "sidebar:archived": { sessions: [archived] },
    },
  })
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") {
      fakeRef.current.sidebarResponse = {
        sections: [],
        entries: { session_1: { archived: false } },
      }
      return fakeRef.current.sidebarResponse
    }
    return notFound()
  }
  expect(
    await useAppStore.getState().changeSidebar({
      type: "session",
      sessionId: archived.id,
      archived: false,
      sectionId: null,
    }),
  ).toBe(true)
  expect(useAppStore.getState().selectedSession?.archived).toBe(false)
  expect(useAppStore.getState().selectedSession?.sectionId).toBeUndefined()
  expect(
    useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
      ?.sessions,
  ).toEqual([])
  expect(
    useAppStore.getState().sessionsByProject["sidebar:archived"]?.sessions,
  ).toEqual([])
  expect(useAppStore.getState().sessionsByProject[""]).toBeUndefined()
  expect(fakeRef.current.requestsFor("session/list")).toHaveLength(0)
})

it("serializes rapid sidebar changes so every request reaches the server in click order", async () => {
  const gate = deferredResponse()
  let updateCalls = 0
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") {
      updateCalls += 1
      return updateCalls === 1 ? gate.promise : fakeRef.current.sidebarResponse
    }
    if (method === "session/list") return { sessions: [] }
    return notFound()
  }
  const pinFirst = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: "session_a",
    sectionId: "pinned",
  })
  const pinSecond = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: "session_b",
    sectionId: "pinned",
  })
  // Flush the queue so the first request is in flight while the second waits.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(
    fakeRef.current
      .requestsFor("sidebar/update")
      .map((request) => (request.params as { sessionId: string }).sessionId),
  ).toEqual(["session_a"])
  gate.resolve(fakeRef.current.sidebarResponse)
  expect(await pinFirst).toBe(true)
  expect(await pinSecond).toBe(true)
  expect(
    fakeRef.current
      .requestsFor("sidebar/update")
      .map((request) => (request.params as { sessionId: string }).sessionId),
  ).toEqual(["session_a", "session_b"])
})

it("resolves queued relative section moves against the latest sidebar", async () => {
  const gate = deferredResponse()
  const initial = {
    sections: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    entries: {},
  }
  const [sectionA, sectionB, sectionC] = initial.sections
  if (
    sectionA === undefined ||
    sectionB === undefined ||
    sectionC === undefined
  ) {
    throw new Error("Expected three sidebar sections")
  }
  const afterFirst = {
    ...initial,
    sections: [sectionB, sectionA, sectionC],
  }
  const afterSecond = {
    ...initial,
    sections: [sectionB, sectionC, sectionA],
  }
  useAppStore.setState({ sidebar: initial })
  let updateCalls = 0
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") {
      updateCalls += 1
      if (updateCalls === 1) return gate.promise
      fakeRef.current.sidebarResponse = afterSecond
      return afterSecond
    }
    if (method === "session/list") return { sessions: [] }
    return notFound()
  }

  const moveA = useAppStore.getState().moveSidebarSection("a", "down")
  const moveC = useAppStore.getState().moveSidebarSection("c", "up")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fakeRef.current.requestsFor("sidebar/update")[0]?.params).toEqual({
    type: "reorder-sections",
    sectionIds: ["b", "a", "c"],
  })

  fakeRef.current.sidebarResponse = afterFirst
  gate.resolve(afterFirst)
  expect(await moveA).toBe(true)
  expect(await moveC).toBe(true)
  expect(fakeRef.current.requestsFor("sidebar/update")[1]?.params).toEqual({
    type: "reorder-sections",
    sectionIds: ["b", "c", "a"],
  })
})

it("keeps the sidebar queue moving after a failed change", async () => {
  let updateCalls = 0
  fakeRef.current.respond = (method) => {
    if (method === "sidebar/update") {
      updateCalls += 1
      if (updateCalls === 1) throw new ApiRequestError("boom", "internal_error")
      return fakeRef.current.sidebarResponse
    }
    if (method === "session/list") return { sessions: [] }
    return notFound()
  }
  const failed = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: "session_a",
    sectionId: "pinned",
  })
  const queued = useAppStore.getState().changeSidebar({
    type: "session",
    sessionId: "session_b",
    sectionId: "pinned",
  })
  expect(await failed).toBe(false)
  expect(await queued).toBe(true)
  expect(
    fakeRef.current
      .requestsFor("sidebar/update")
      .map((request) => (request.params as { sessionId: string }).sessionId),
  ).toEqual(["session_a", "session_b"])
  expect(useAppStore.getState().inFlightActions.has("sidebar-update")).toBe(
    false,
  )
  expect(useAppStore.getState().message).toBe("boom")
})

it("rebuilds only the lists containing the selected session on durable stream events", async () => {
  useAppStore.setState({
    sessionsByProject: {
      "": { sessions: [{ ...sessionDetail }] },
      project_b: { sessions: [{ ...sessionDetail, id: "session_2" }] },
    },
  })
  await useAppStore.getState().selectSession("session_1")
  const stream = fakeRef.current.streams[0]
  emitSnapshot(stream, sessionDetail)
  const before = useAppStore.getState().sessionsByProject
  stream?.emitEvent(
    createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.TurnStarted,
        data: { turnId: "turn_1", inputId: "input_1" },
      },
    }),
  )
  const after = useAppStore.getState().sessionsByProject
  expect(after[""]).not.toBe(before[""])
  expect(after[""]?.sessions[0]?.seq).toBe(2)
  expect(after.project_b).toBe(before.project_b)

  // An event that does not advance the session leaves every list untouched.
  stream?.emitEvent(
    createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.TurnStarted,
        data: { turnId: "turn_1", inputId: "input_1" },
      },
    }),
  )
  expect(useAppStore.getState().sessionsByProject).toBe(after)
})

it("keeps session lists stable when an activity broadcast changes no active flags", async () => {
  useAppStore.setState({
    sessionsByProject: {
      "": { sessions: [{ ...sessionDetail, active: true }] },
    },
  })
  await useAppStore.getState().boot()
  const before = useAppStore.getState().sessionsByProject
  fakeRef.current.emitSessionActivity(["session_1"])
  expect(useAppStore.getState().sessionsByProject).toBe(before)
  fakeRef.current.emitSessionActivity([])
  const after = useAppStore.getState().sessionsByProject
  expect(after[""]?.sessions[0]?.active).toBe(false)
})

it("keeps the sidebar order when an already listed search result is selected", async () => {
  const first = { ...sessionDetail, id: "session_first" }
  const second = { ...sessionDetail, id: "session_second" }
  useAppStore.setState({
    sessionsByProject: { "": { sessions: [first, second] } },
  })
  fakeRef.current.respond = () => notFound()
  await useAppStore.getState().selectSession(second.id, second)
  expect(
    useAppStore.getState().sessionsByProject[""]?.sessions.map((s) => s.id),
  ).toEqual(["session_first", "session_second"])
})

it.each(
  [
    { draft: "hi", expected: undefined, order: "queue-first" },
    { draft: "Next question", expected: "Next question", order: "queue-first" },
    { draft: "hi", expected: undefined, order: "rpc-first" },
    { draft: "Next question", expected: "Next question", order: "rpc-first" },
  ].flatMap((scenario) =>
    ["before-replay", "during-replay"].map((start) => ({ ...scenario, start })),
  ),
)("settles the first admitted draft after overlapping initial replay: $draft / $order / $start", async ({
  draft,
  expected,
  order,
  start,
}) => {
  const admission = deferredResponse()
  const queue = deferredResponse()
  fakeRef.current.respond = (method) => {
    if (method === "session/create")
      return {
        session: sessionDetail,
        event: createEventEnvelope({
          sessionId: "session_1",
          seq: 1,
          event: { type: EventType.SessionCreated, data: {} },
        }),
      }
    if (method === "session/input") return admission.promise
    if (method === "session/queue/list") return queue.promise
    if (method === "session/skills") return { skills: [] }
    if (method === "session/list") return { sessions: [] }
    return notFound()
  }
  if (start === "during-replay") {
    await useAppStore.getState().createSession()
    const initialStream = fakeRef.current.streams[0]
    if (!initialStream) throw new Error("Missing initial stream")
    emitSnapshot(initialStream)
    initialStream.emitReplayComplete()
  }
  useAppStore.getState().setPromptDraft(inputParts("hi"))
  const sending = useAppStore.getState().admitInput(inputParts("hi"))
  await vi.waitFor(() =>
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1),
  )
  useAppStore.getState().setPromptDraft(inputParts(draft))
  const request = fakeRef.current.requestsFor("session/input")[0]?.params as {
    requestId: string
  }
  const stream = fakeRef.current.streams[0]
  if (!stream) throw new Error("Missing initial stream")
  if (start === "before-replay") {
    emitSnapshot(stream)
    stream.emitReplayComplete()
  }
  // Let the replay's empty queue read reconcile while the live send is pending.
  await vi.waitFor(() =>
    expect(fakeRef.current.requestsFor("session/queue/list")).toHaveLength(1),
  )
  if (order === "rpc-first") {
    admission.resolve({
      content: requestedInputContent(request.requestId),
      requestId: request.requestId,
      inputId: "input_1",
    })
    await sending
  }
  queue.resolve({ items: [] })
  await queue.promise
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  stream.emitEvent(
    createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: request.requestId,
          inputId: "input_1",
          role: InputRole.User,
          content: inputFixture(inputParts("hi")),
        },
      },
    }),
  )
  admission.resolve({
    content: requestedInputContent(request.requestId),
    requestId: request.requestId,
    inputId: "input_1",
  })
  await sending
  expect(
    useAppStore.getState().execution.admittedRequestIds[request.requestId],
  ).toBe(true)
  expect(useAppStore.getState().promptDraft).toEqual(
    expected === undefined ? undefined : inputParts(expected),
  )
})

it.each([
  "terminal rejection",
  "transport failure",
])("preserves admission recovery after overlapping replay and %s", async (failure) => {
  const admission = deferredResponse()
  const queue = deferredResponse()
  fakeRef.current.respond = (method) => {
    if (method === "session/create")
      return {
        session: sessionDetail,
        event: createEventEnvelope({
          sessionId: "session_1",
          seq: 1,
          event: { type: EventType.SessionCreated, data: {} },
        }),
      }
    if (method === "session/input") return admission.promise
    if (method === "session/queue/list") return queue.promise
    if (method === "session/skills") return { skills: [] }
    if (method === "session/list") return { sessions: [] }
    return notFound()
  }
  useAppStore.getState().setPromptDraft(inputParts("hi"))
  const sending = useAppStore.getState().admitInput(inputParts("hi"))
  await vi.waitFor(() =>
    expect(fakeRef.current.requestsFor("session/input")).toHaveLength(1),
  )
  const request = fakeRef.current.requestsFor("session/input")[0]?.params as {
    requestId: string
  }
  const stream = fakeRef.current.streams[0]
  if (!stream) throw new Error("Missing initial stream")
  useAppStore.getState().setPromptDraft(inputParts("Next question"))
  emitSnapshot(stream)
  stream.emitReplayComplete()
  queue.resolve({ items: [] })
  await queue.promise
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(useAppStore.getState().promptDraft).toEqual(
    inputParts("Next question"),
  )
  if (failure === "terminal rejection") {
    stream.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: 2,
        event: {
          type: EventType.TurnCompleted,
          data: { turnId: request.requestId, outcome: { status: "completed" } },
        },
      }),
    )
    admission.resolve({
      content: requestedInputContent(request.requestId),
      requestId: request.requestId,
      inputId: "input_1",
    })
  } else {
    admission.reject(new Error("Connection lost"))
  }
  await sending
  if (failure === "transport failure") {
    expect(useAppStore.getState().message).toBe(
      "Sending status is unconfirmed. This input has not been resent.",
    )
    stream.emitReplayComplete()
  }
  await vi.waitFor(() =>
    expect(useAppStore.getState().promptDraft).toEqual(
      inputFixture([
        { type: "text", text: "hi" },
        { type: "text", text: "\n" },
        { type: "text", text: "Next question" },
      ]),
    ),
  )
  expect(
    useAppStore.getState().execution.admittedRequestIds[request.requestId],
  ).toBeUndefined()
})

it("keeps an unconfirmed delivery notice when older background requests fail", async () => {
  const list = deferredResponse()
  const admission = deferredResponse()
  fakeRef.current.respond = (method) => {
    if (method === "goal/clear")
      throw new ApiRequestError("Could not clear goal.", "internal_error")
    if (method === "session/list") return list.promise
    if (method === "session/input") return admission.promise
    if (method === "session/queue/list") return { items: [] }
    if (method === "session/skills") return { skills: [] }
    return notFound()
  }
  await useAppStore.getState().selectSession("session_1")
  const stream = fakeRef.current.streams.at(-1)
  emitSnapshot(stream)
  stream?.emitReplayComplete()
  const loading = useAppStore.getState().loadSessions(undefined)
  useAppStore.getState().setPromptDraft(inputParts("Unconfirmed input"))
  const sending = useAppStore
    .getState()
    .admitInput(inputParts("Unconfirmed input"))
  admission.reject(
    new ApiRequestError("The connection to the server was lost."),
  )
  await sending
  const notice =
    "Sending status is unconfirmed. This input has not been resent."
  expect(useAppStore.getState().message).toBe(notice)
  list.reject(new ApiRequestError("The connection to the server was lost."))
  await loading
  stream?.disconnect(
    new ApiRequestError("The connection to the server was lost."),
  )
  expect(useAppStore.getState().message).toBe(notice)
  expect(useAppStore.getState().promptDraft).toEqual(
    inputParts("Unconfirmed input"),
  )
  await useAppStore.getState().clearGoal("session_1")
  expect(useAppStore.getState().message).toBe("Could not clear goal.")
})

it("keeps an unconfirmed notice across replay and preserves a later draft with identical text", async () => {
  fakeRef.current.respond = (method) =>
    method === "session/queue/list"
      ? { items: [] }
      : method === "session/skills"
        ? { skills: [] }
        : notFound()
  const admission = inputRecoveryMemory.reserveAdmission({
    apiBase: useAppStore.getState().apiBase,
    sessionId: "session_1",
    content: inputFixture(inputParts("Same text")),
  })
  await useAppStore.getState().selectSession("session_1")
  const stream = fakeRef.current.streams[0]
  if (!stream) throw new Error("Missing stream")
  emitSnapshot(stream)
  stream.emitReplayComplete()
  await vi.waitFor(() =>
    expect(useAppStore.getState().promptDraft).toEqual(inputParts("Same text")),
  )
  useAppStore.setState({ message: undefined })
  stream.emitReplayComplete()
  await vi.waitFor(() =>
    expect(useAppStore.getState().message).toBe(
      "Sending status is unconfirmed. This input has not been resent.",
    ),
  )
  useAppStore.getState().setPromptDraft(inputParts("Same text"))
  stream.emitEvent(
    createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: admission.requestId,
          inputId: "input_confirmed",
          role: InputRole.User,
          content: admission.content,
        },
      },
    }),
  )
  expect(useAppStore.getState().promptDraft).toEqual(inputParts("Same text"))
  expect(useAppStore.getState().message).toBeUndefined()
  expect(
    inputRecoveryMemory.listAdmissionsForSession(
      useAppStore.getState().apiBase,
      "session_1",
    ),
  ).toEqual([])
  expect(fakeRef.current.requestsFor("session/input")).toEqual([])
})

it("retires all confirmed recovery fragments even when receipts arrive before their draft prefix", async () => {
  fakeRef.current.respond = (method) =>
    method === "session/queue/list"
      ? { items: [] }
      : method === "session/skills"
        ? { skills: [] }
        : notFound()
  const first = inputRecoveryMemory.reserveAdmission({
    apiBase: useAppStore.getState().apiBase,
    sessionId: "session_1",
    content: inputFixture(inputParts("First")),
  })
  const second = inputRecoveryMemory.reserveAdmission({
    apiBase: useAppStore.getState().apiBase,
    sessionId: "session_1",
    content: inputFixture(inputParts("Second")),
  })
  await useAppStore.getState().selectSession("session_1")
  const stream = fakeRef.current.streams[0]
  if (!stream) throw new Error("Missing stream")
  emitSnapshot(stream)
  stream.emitReplayComplete()
  await vi.waitFor(() =>
    expect(useAppStore.getState().promptDraft?.text).toBe("Second\nFirst"),
  )
  for (const [index, input] of [first, second].entries())
    stream.emitEvent(
      createEventEnvelope({
        sessionId: "session_1",
        seq: index + 2,
        event: {
          type: EventType.InputAdmitted,
          data: {
            requestId: input.requestId,
            inputId: `input_${index}`,
            role: InputRole.User,
            content: input.content,
          },
        },
      }),
    )
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(
    inputRecoveryMemory.listAdmissionsForSession(
      useAppStore.getState().apiBase,
      "session_1",
    ),
  ).toEqual([])
  expect(fakeRef.current.requestsFor("session/input")).toEqual([])
})

describe("goal projections", () => {
  const goal: ThreadGoal = {
    id: "goal_1",
    threadId: "session_1",
    objective: "Ship it",
    status: "active",
    tokensUsed: 30,
    timeUsedSeconds: 5,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:01.000Z",
  }
  async function boot() {
    fakeRef.current.respond = (method) => {
      if (method === "provider/list") return { accounts: [], providers: [] }
      if (method === "project/list") return { projects: [] }
      if (method === "session/list") return { sessions: [] }
      throw new Error(`Unexpected request: ${method}`)
    }
    await useAppStore.getState().boot()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      selectedSession: { ...sessionDetail, goal },
      sessionsByProject: { "": { sessions: [{ ...sessionDetail, goal }] } },
    })
  }

  it("updates selected and cached goals without a sidebar change, including clears", async () => {
    await boot()
    const paused = { ...goal, status: "paused" as const, tokensUsed: 50 }
    fakeRef.current.emitGoalChanged({ sessionId: "session_1", goal: paused })
    expect(useAppStore.getState().selectedSession?.goal).toEqual(paused)
    expect(
      useAppStore.getState().sessionsByProject[""]?.sessions[0]?.goal,
    ).toEqual(paused)
    fakeRef.current.emitGoalChanged({ sessionId: "session_1", goal: null })
    expect(useAppStore.getState().selectedSession).not.toHaveProperty("goal")
    expect(
      useAppStore.getState().sessionsByProject[""]?.sessions[0],
    ).not.toHaveProperty("goal")
  })

  it.each([
    "read",
    "set",
    "clear",
  ] as const)("ignores a goal %s response from before a history replacement", async (operation) => {
    await boot()
    const response = deferredResponse()
    fakeRef.current.respond = (method) => {
      if (method === `goal/${operation}`) return response.promise
      if (method === "session/revert")
        return {
          session: {
            ...sessionDetail,
            rolloutId: "rollout_reverted",
            goal,
          },
          events: [],
          historyEndSeqExclusive: 2,
        }
      return notFound()
    }
    let saving: Promise<unknown> | undefined
    if (operation === "read") fakeRef.current.emitGoalChanged(undefined)
    else if (operation === "set")
      saving = useAppStore
        .getState()
        .setGoal({ sessionId: "session_1", status: "paused" })
    else saving = useAppStore.getState().clearGoal("session_1")
    await useAppStore.getState().revertSession("input_1", "undo")
    response.resolve({ goal: null })
    await saving
    await Promise.resolve()
    await Promise.resolve()
    expect(useAppStore.getState().selectedSession?.goal).toEqual(goal)
    expect(
      useAppStore.getState().sessionsByProject[""]?.sessions[0]?.goal,
    ).toEqual(goal)
  })

  it.each([
    "complete",
    "clear",
  ])("keeps a newer %s notification when an older mutation response arrives", async (change) => {
    await boot()
    fakeRef.current.emitGoalChanged({ sessionId: "session_1", goal: null })
    const response = deferredResponse()
    fakeRef.current.respond = () => response.promise
    const saving = useAppStore
      .getState()
      .setGoal({ sessionId: "session_1", status: "active" })
    fakeRef.current.emitGoalChanged({ sessionId: "session_1", goal })
    const completed =
      change === "complete"
        ? { ...goal, status: "complete" as const, tokensUsed: 200 }
        : null
    fakeRef.current.emitGoalChanged({ sessionId: "session_1", goal: completed })
    response.resolve({ goal })
    await saving
    expect(useAppStore.getState().selectedSession?.goal).toEqual(
      completed ?? undefined,
    )
  })

  it("keeps a live clear when an older session list finishes loading", async () => {
    await boot()
    const response = deferredResponse()
    fakeRef.current.respond = () => response.promise
    const loading = useAppStore.getState().loadSessions(undefined)
    fakeRef.current.emitGoalChanged({ sessionId: "session_1", goal: null })
    response.resolve({ sessions: [{ ...sessionDetail, goal }] })
    await loading
    expect(
      useAppStore.getState().sessionsByProject[""]?.sessions[0],
    ).not.toHaveProperty("goal")
    expect(useAppStore.getState().sessionsByProject[""]?.loading).not.toBe(true)
  })

  it("refreshes the selected goal after reconnect", async () => {
    await boot()
    fakeRef.current.respond = (method) => {
      if (method === "goal/read") return { goal: null }
      throw new Error(`Unexpected request: ${method}`)
    }
    fakeRef.current.emitGoalChanged(undefined)
    await vi.waitFor(() =>
      expect(useAppStore.getState().selectedSession).not.toHaveProperty("goal"),
    )
    expect(fakeRef.current.requestsFor("goal/read")[0]?.params).toEqual({
      sessionId: "session_1",
    })
  })
})

function requestedInputContent(requestId: string): InputContent {
  const request = fakeRef.current.requests.find(
    ({ method, params }) =>
      method.startsWith("session/input") &&
      (params as { requestId?: string }).requestId === requestId,
  )
  if (!request) throw new Error("Missing test input request")
  return structuredClone((request.params as { content: InputContent }).content)
}

it.each([
  "success",
  "failure",
] as const)("keeps the latest usage read when an older %s completes after settings are reopened", async (outcome) => {
  const older = deferredResponse()
  const newer = deferredResponse()
  fakeRef.current.respond = (method) => {
    if (method !== "usage/read") return notFound()
    return fakeRef.current.requestsFor("usage/read").length === 1
      ? older.promise
      : newer.promise
  }
  const oldRead = useAppStore.getState().loadUsage()
  const newRead = useAppStore.getState().loadUsage()
  const usage = {
    generatedAt: "2026-10-08T15:00:00Z",
    totals: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      turns: 1,
    },
    days: [],
    models: [],
    modelDays: [],
    threads: [],
  }
  newer.resolve({ usage })
  await newRead
  if (outcome === "failure") older.reject(new Error("Old usage failed"))
  else
    older.resolve({
      usage: { ...usage, generatedAt: "2026-10-08T14:00:00Z" },
    })
  await oldRead
  expect(useAppStore.getState().usage).toEqual({
    summary: usage,
    loading: false,
  })
})

it("ignores a superseded queue read failure after the latest queue refresh succeeds", async () => {
  const older = deferredResponse()
  fakeRef.current.respond = (method) => {
    if (method !== "session/queue/list") return notFound()
    return fakeRef.current.requestsFor(method).length === 1
      ? older.promise
      : { items: [] }
  }
  useAppStore.setState({ selection: { sessionId: "session_1" } })
  const oldRead = useAppStore.getState().refreshQueuedInputs()
  await useAppStore.getState().refreshQueuedInputs()
  older.reject(new Error("Superseded queue read failed"))
  await oldRead
  expect(useAppStore.getState().message).toBeUndefined()
  expect(useAppStore.getState().queuedItems).toEqual([])
})

describe("selected queue ownership", () => {
  it.each([
    "clear",
    "new",
    "create",
    "revert",
    "delete",
  ])("releases the old queue when %s changes the selection", async (action) => {
    const nextSession = {
      ...sessionDetail,
      id: "session_2",
      conversationId: "conversation_2",
    }
    const nextItem = {
      id: "queued_next",
      sessionId: action === "revert" ? sessionDetail.id : "session_2",
      input: {
        submissionId: "request_next",
        content: inputFixture(inputParts("next")),
      },
      createdAt: sessionDetail.createdAt,
    }
    fakeRef.current.respond = (method) => {
      if (method === "session/create")
        return {
          session: nextSession,
          event: createEventEnvelope({
            sessionId: nextSession.id,
            seq: 1,
            event: { type: "session.created", data: {} },
          }),
        }
      if (method === "session/revert")
        return { session: sessionDetail, events: [], historyEndSeqExclusive: 2 }
      if (method === "session/queue/list") return { items: [nextItem] }
      if (method === "session/skills") return { skills: [] }
      if (method === "session/delete") return { sessionId: sessionDetail.id }
      if (method === "sidebar/read") return { sections: [], entries: {} }
      throw new ApiRequestError("not found", "not_found")
    }
    useAppStore.setState({
      selection: { sessionId: sessionDetail.id },
      selectedSession: sessionDetail,
      queuedItems: [
        { ...nextItem, id: "queued_old", sessionId: sessionDetail.id },
      ],
    })
    if (action === "clear") useAppStore.getState().clearSessionSelection()
    if (action === "new") useAppStore.getState().startNewSession()
    if (action === "create") await useAppStore.getState().createSession()
    if (action === "revert")
      await useAppStore
        .getState()
        .revertSession(
          "input_1",
          "edit",
          inputFixture(inputParts("replacement")),
        )
    if (action === "delete")
      await useAppStore.getState().deleteSession(sessionDetail.id)
    if (action === "clear" || action === "new" || action === "delete") {
      expect(useAppStore.getState().selection.sessionId).toBeUndefined()
      expect(useAppStore.getState().queuedItems).toEqual([])
    } else {
      const selected = action === "revert" ? sessionDetail : nextSession
      await vi.waitFor(() =>
        expect(useAppStore.getState().selection.sessionId).toBe(selected.id),
      )
      const stream = fakeRef.current.streams.at(-1)
      emitSnapshot(stream, selected)
      stream?.emitReplayComplete()
      await vi.waitFor(() =>
        expect(useAppStore.getState().queuedItems).toEqual([nextItem]),
      )
      expect(useAppStore.getState().selection.sessionId).toBe(selected.id)
    }
  })
})

it("releases input submission before an unrelated sidebar refresh completes", async () => {
  const sidebar = deferredResponse()
  fakeRef.current.respond = (method, params) => {
    if (method === "session/input") {
      const { requestId, content } = params as {
        requestId: string
        content: InputContent
      }
      return { requestId, content, inputId: "input_accepted" }
    }
    if (method === "sidebar/read") return sidebar.promise
    if (method === "session/list") return { sessions: [] }
    return notFound()
  }
  useAppStore.setState({ selection: { sessionId: "session_1" } })
  await useAppStore.getState().admitInput(inputParts("first"))
  expect(useAppStore.getState().inFlightActions.has("admit:session_1")).toBe(
    false,
  )
  await useAppStore.getState().admitInput(inputParts("second"))
  expect(fakeRef.current.requestsFor("session/input")).toHaveLength(2)
  sidebar.resolve({ sections: [], entries: {} })
})

it.each([
  "session/input",
  "session/input/steer",
] as const)("keeps an explicit %s rejection out of unknown-delivery recovery", async (method) => {
  fakeRef.current.respond = () => {
    throw new ApiRequestError("Invalid model selection", "invalid_input")
  }
  useAppStore.setState({
    selection: { sessionId: "session_1" },
    promptDraft: inputParts("hello"),
    execution: {
      ...createExecutionViewState(),
      ...(method.endsWith("steer") ? { activeTurnId: "turn_1" } : {}),
    },
  })
  await useAppStore.getState().admitInput(inputParts("hello"))
  expect(useAppStore.getState().message).toBe("Invalid model selection")
  expect(useAppStore.getState().promptDraft).toEqual(inputParts("hello"))
  expect(
    inputRecoveryMemory.listAdmissionsForSession(
      useAppStore.getState().apiBase,
      "session_1",
    ),
  ).toEqual([])
  expect(
    inputRecoveryMemory.readSteers(useAppStore.getState().apiBase, "session_1"),
  ).toEqual([])
  expect(useAppStore.getState().inFlightActions.has("admit:session_1")).toBe(
    false,
  )
})

it("dismisses an old reminder without resending or losing late acknowledgement recovery", async () => {
  fakeRef.current.respond = (method) =>
    method === "session/queue/list"
      ? { items: [] }
      : method === "session/skills"
        ? { skills: [] }
        : notFound()
  const admission = inputRecoveryMemory.reserveAdmission({
    apiBase: useAppStore.getState().apiBase,
    sessionId: "session_1",
    content: inputFixture(inputParts("earlier")),
  })
  await useAppStore.getState().selectSession("session_1")
  const stream = fakeRef.current.streams[0]
  emitSnapshot(stream)
  stream?.emitReplayComplete()
  await vi.waitFor(() =>
    expect(useAppStore.getState().message).toContain("unconfirmed"),
  )
  useAppStore.getState().dismissInputRecoveryNotice()
  expect(useAppStore.getState().message).toBeUndefined()
  expect(useAppStore.getState().promptDraft).toEqual(inputParts("earlier"))
  stream?.emitReplayComplete()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(useAppStore.getState().message).toBeUndefined()
  expect(
    inputRecoveryMemory.listAdmissionsForSession(
      useAppStore.getState().apiBase,
      "session_1",
    ),
  ).toHaveLength(1)
  stream?.emitEvent(
    createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: admission.requestId,
          inputId: "confirmed",
          role: InputRole.User,
          content: admission.content,
        },
      },
    }),
  )
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(
    inputRecoveryMemory.listAdmissionsForSession(
      useAppStore.getState().apiBase,
      "session_1",
    ),
  ).toEqual([])
  expect(fakeRef.current.requestsFor("session/input")).toHaveLength(0)
})

it.each([
  "session/input",
  "session/input/steer",
] as const)("retains unknown delivery after %s returns an internal commit error", async (method) => {
  fakeRef.current.respond = () => {
    throw new ApiRequestError("Durability fence failed", "internal_error")
  }
  useAppStore.setState({
    selection: { sessionId: "session_1" },
    promptDraft: inputParts("hello"),
    execution: {
      ...createExecutionViewState(),
      ...(method.endsWith("steer") ? { activeTurnId: "turn_1" } : {}),
    },
  })
  await useAppStore.getState().admitInput(inputParts("hello"))
  expect(useAppStore.getState().message).toContain("unconfirmed")
  const records = method.endsWith("steer")
    ? inputRecoveryMemory.readSteers(
        useAppStore.getState().apiBase,
        "session_1",
      )
    : inputRecoveryMemory.listAdmissionsForSession(
        useAppStore.getState().apiBase,
        "session_1",
      )
  expect(records).toHaveLength(1)
  expect(records[0]?.restored).toBe(true)
})

it.each([
  "session/input",
  "session/input/steer",
] as const)("trusts durable confirmation when the %s acknowledgement later fails", async (method) => {
  const reply = deferredResponse()
  fakeRef.current.respond = (name) =>
    name === method
      ? reply.promise
      : name === "session/queue/list"
        ? { items: [] }
        : name === "session/skills"
          ? { skills: [] }
          : notFound()
  await useAppStore.getState().selectSession("session_1")
  const stream = fakeRef.current.streams[0]
  emitSnapshot(stream)
  stream?.emitReplayComplete()
  useAppStore.setState({
    promptDraft: inputParts("change direction"),
    execution: {
      ...createExecutionViewState(),
      ...(method.endsWith("steer") ? { activeTurnId: "turn_1" } : {}),
    },
  })
  const sending = useAppStore
    .getState()
    .admitInput(inputParts("change direction"))
  await vi.waitFor(() =>
    expect(fakeRef.current.requestsFor(method)).toHaveLength(1),
  )
  const params = fakeRef.current.requestsFor(method)[0]?.params as {
    requestId: string
    content: InputContent
  }
  stream?.emitEvent(
    createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: params.requestId,
          inputId: "confirmed",
          role: InputRole.User,
          content: params.content,
        },
      },
    }),
  )
  reply.reject(new ApiRequestError("Acknowledgement timed out"))
  await sending
  expect(useAppStore.getState().message).toBeUndefined()
  expect(useAppStore.getState().promptDraft).toBeUndefined()
  expect(
    inputRecoveryMemory.listAdmissionsForSession(
      useAppStore.getState().apiBase,
      "session_1",
    ),
  ).toEqual([])
  expect(
    inputRecoveryMemory.readSteers(useAppStore.getState().apiBase, "session_1"),
  ).toEqual([])
})
