import "./setup-store-environment.ts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { inputRecoveryMemory } from "../../src/gui/input-recovery-memory.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"
import { createEventEnvelope, EventType } from "../../src/kernel/events.ts"
import type {
  ApiSessionDetail,
  ApiSessionSummary,
} from "../../src/protocol/application.ts"
import { FakeRpcClient } from "../gui/fake-rpc-client.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))

vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => fakeRef.current,
}))

const session: ApiSessionDetail = {
  id: "session_1",
  conversationId: "conversation_1",
  seq: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  active: true,
  status: "working",
  activeTurnId: "turn_1",
  pendingInputs: [],
  pendingPermissions: [],
  counts: {
    inputs: 1,
    pendingInputs: 0,
    turns: 1,
    items: 0,
    permissions: 0,
    tools: 0,
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function firstRow() {
  return useAppStore.getState().sessionsByProject[""]?.sessions[0]
}

function completeItem() {
  fakeRef.current.streams[0]?.emitEvent(
    createEventEnvelope({
      sessionId: session.id,
      seq: 2,
      event: {
        type: EventType.ItemCompleted,
        data: {
          turnId: "turn_1",
          item: { type: "reasoning", itemId: "reasoning_1", text: "Checking" },
        },
      },
    }),
  )
}

async function boot(sessions: ApiSessionSummary[] = [session]) {
  fakeRef.current.respond = (method) => {
    if (method === "provider/list") return { accounts: [], providers: [] }
    if (method === "project/list") return { projects: [] }
    if (method === "session/list") return { sessions, nextCursor: "page_2" }
    if (method === "session/skills") return { skills: [] }
    throw new ApiRequestError("not found", "not_found")
  }
  await useAppStore.getState().boot()
}

beforeEach(() => {
  globalThis.localStorage.clear()
  inputRecoveryMemory.clear()
  fakeRef.current = new FakeRpcClient()
  useAppStore.setState(
    { ...useAppStore.getInitialState(), ...createInitialAppState() },
    true,
  )
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
  useAppStore.setState({ apiBase: "http://api.test" })
})

describe("sidebar status authority", () => {
  it.each([
    ["waiting", "working"],
    ["working", "waiting"],
  ] as const)("keeps refreshed %s → %s status when ordinary durable output arrives", async (snapshotStatus, authoritativeStatus) => {
    await boot([{ ...session, status: snapshotStatus }])
    fakeRef.current.streams[0]?.emitSnapshot({
      session: { ...session, status: snapshotStatus },
    })
    fakeRef.current.respond = (method) => {
      if (method === "session/status")
        return { active: true, status: authoritativeStatus }
      throw new ApiRequestError("not found", "not_found")
    }
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    await vi.waitFor(() => expect(firstRow()?.status).toBe(authoritativeStatus))

    completeItem()

    expect(firstRow()).toMatchObject({
      seq: 2,
      active: true,
      status: authoritativeStatus,
    })
    expect(fakeRef.current.requestsFor("session/read")).toEqual([])
  })

  it("keeps authoritative inactivity when output advances a stale active snapshot", async () => {
    await boot()
    fakeRef.current.streams[0]?.emitSnapshot({ session })
    fakeRef.current.respond = () => ({ status: "failed" })
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    await vi.waitFor(() => expect(firstRow()?.status).toBe("failed"))

    completeItem()

    expect(firstRow()).toMatchObject({
      active: false,
      status: "failed",
      seq: 2,
    })
  })

  it("ignores an older status read that finishes after a newer notification", async () => {
    await boot()
    const older = deferred<{ active: boolean; status: "waiting" }>()
    const newer = deferred<{ active: boolean; status: "working" }>()
    let reads = 0
    fakeRef.current.respond = () =>
      ++reads === 1 ? older.promise : newer.promise
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    newer.resolve({ active: true, status: "working" })
    await vi.waitFor(() =>
      expect(fakeRef.current.requestsFor("session/status")).toHaveLength(2),
    )
    older.resolve({ active: true, status: "waiting" })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(firstRow()?.status).toBe("working")
  })

  it("keeps a newer permission status when a list response arrives late", async () => {
    await boot()
    const staleList = deferred<{ sessions: ApiSessionSummary[] }>()
    fakeRef.current.respond = (method) =>
      method === "session/list"
        ? staleList.promise
        : { active: true, status: "waiting" }
    const loading = useAppStore.getState().loadSessions(undefined)
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    await vi.waitFor(() => expect(firstRow()?.status).toBe("waiting"))
    staleList.resolve({ sessions: [session] })
    await loading

    expect(firstRow()?.status).toBe("waiting")
  })

  it("preserves a pending permission when activity announces the running turn", async () => {
    await boot([{ ...session, active: false, status: "waiting" }])
    fakeRef.current.emitSessionActivity([session.id])
    expect(firstRow()).toMatchObject({ active: true, status: "waiting" })
  })

  it("advances the completion watermark without projecting detail status", async () => {
    await boot()
    fakeRef.current.streams[0]?.emitSnapshot({ session })
    fakeRef.current.streams[0]?.emitEvent(
      createEventEnvelope({
        sessionId: session.id,
        seq: 2,
        event: {
          type: EventType.TurnCompleted,
          data: { turnId: "turn_1", outcome: { status: "completed" } },
        },
      }),
    )
    expect(firstRow()).toMatchObject({
      latestCompletionSeq: 2,
      active: true,
      status: "working",
    })
    fakeRef.current.respond = () => ({ status: "idle" })
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    await vi.waitFor(() => expect(firstRow()?.status).toBe("idle"))
    expect(firstRow()?.latestCompletionSeq).toBe(2)
  })
})

it("updates unopened rows without dropping loaded pages or the next cursor", async () => {
  const rows: ApiSessionSummary[] = Array.from({ length: 61 }, (_, index) => ({
    ...session,
    id: `session_${index + 1}`,
    title: `Conversation ${index + 1}`,
  }))
  await boot(rows.slice(0, 30))
  fakeRef.current.respond = (method, params) => {
    if (method === "session/status") return { active: true, status: "waiting" }
    const { cursor } = params as { cursor?: string }
    return cursor === "page_2"
      ? { sessions: rows.slice(30, 60), nextCursor: "page_3" }
      : { sessions: rows.slice(60) }
  }
  await useAppStore.getState().loadSessions(undefined, { append: true })
  const before = useAppStore.getState().sessionsByProject[""]
  const listReads = fakeRef.current.requestsFor("session/list").length
  useAppStore.setState({
    sessionsByProject: {
      ...useAppStore.getState().sessionsByProject,
      "sidebar:section:pinned": {
        sessions: [{ ...session, id: "session_45", sectionId: "pinned" }],
        nextCursor: "pinned_page_2",
      },
    },
  })

  fakeRef.current.emitSidebarChanged({ sessionId: "session_45" })
  await vi.waitFor(() =>
    expect(
      useAppStore.getState().sessionsByProject[""]?.sessions[44]?.status,
    ).toBe("waiting"),
  )

  const lists = useAppStore.getState().sessionsByProject
  expect(lists[""]?.sessions.map((row) => row.id)).toEqual(
    before?.sessions.map((row) => row.id),
  )
  expect(lists[""]?.nextCursor).toBe("page_3")
  expect(lists["sidebar:section:pinned"]).toMatchObject({
    nextCursor: "pinned_page_2",
    sessions: [{ id: "session_45", status: "waiting", sectionId: "pinned" }],
  })
  expect(fakeRef.current.requestsFor("session/list")).toHaveLength(listReads)
  expect(fakeRef.current.requestsFor("session/read")).toEqual([])

  await useAppStore.getState().loadSessions(undefined, { append: true })
  expect(useAppStore.getState().sessionsByProject[""]?.sessions).toHaveLength(
    61,
  )
  expect(
    fakeRef.current.requestsFor("session/list").at(-1)?.params,
  ).toMatchObject({
    cursor: "page_3",
  })
})
