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
import type { SessionSidebar } from "../../src/protocol/sidebar.ts"
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
  rolloutId: "rollout_1",
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

function sessionSummary(
  patch: Partial<ApiSessionSummary> = {},
): ApiSessionSummary {
  return {
    id: session.id,
    rolloutId: session.rolloutId,
    conversationId: session.conversationId,
    seq: session.seq,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...patch,
  }
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
      if (method === "session/summary")
        return sessionSummary({ active: true, status: authoritativeStatus })
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
    fakeRef.current.respond = () => sessionSummary({ status: "failed" })
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
    const older = deferred<ApiSessionSummary>()
    const newer = deferred<ApiSessionSummary>()
    let reads = 0
    fakeRef.current.respond = () =>
      ++reads === 1 ? older.promise : newer.promise
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    newer.resolve(sessionSummary({ active: true, status: "working" }))
    await vi.waitFor(() =>
      expect(fakeRef.current.requestsFor("session/summary")).toHaveLength(2),
    )
    older.resolve(sessionSummary({ active: true, status: "waiting" }))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(firstRow()?.status).toBe("working")
  })

  it("keeps a newer permission status when a list response arrives late", async () => {
    await boot()
    const staleList = deferred<{ sessions: ApiSessionSummary[] }>()
    fakeRef.current.respond = (method) =>
      method === "session/list"
        ? staleList.promise
        : sessionSummary({ active: true, status: "waiting" })
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
    fakeRef.current.respond = () => sessionSummary({ status: "idle" })
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
    if (method === "session/summary")
      return sessionSummary({
        id: "session_45",
        active: true,
        status: "waiting",
      })
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

describe("sidebar session discovery", () => {
  const independent = sessionSummary({
    id: "independent_worker",
    conversationId: "independent_worker",
    parentSessionId: session.id,
    projectId: "project_1",
    title: "Independent worker",
    updatedAt: "2026-11-12T00:00:00.000Z",
    status: "idle",
  })

  it("reveals an independent session in loaded lists while retaining all loaded pages", async () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      sessionSummary({
        id: `loaded_${String(60 - index).padStart(2, "0")}`,
        projectId: "project_1",
      }),
    )
    await boot([])
    useAppStore.setState({
      sessionsByProject: {
        "": { sessions: rows, nextCursor: "all_page_3" },
        project_1: { sessions: rows, nextCursor: "project_page_3" },
        project_2: { sessions: [] },
        "sidebar:archived": { sessions: [] },
        "sidebar:section:pinned": { sessions: [] },
      },
    })
    const listReads = fakeRef.current.requestsFor("session/list").length
    fakeRef.current.respond = () => independent
    fakeRef.current.emitSidebarChanged({ sessionId: independent.id })
    await vi.waitFor(() => expect(firstRow()?.title).toBe("Independent worker"))

    const lists = useAppStore.getState().sessionsByProject
    for (const key of ["", "project_1"]) {
      expect(lists[key]?.sessions).toHaveLength(61)
      expect(lists[key]?.sessions[0]).toEqual(independent)
      expect(lists[key]?.sessions.slice(1).map((row) => row.id)).toEqual(
        rows.map((row) => row.id),
      )
    }
    expect(lists[""]?.nextCursor).toBe("all_page_3")
    expect(lists.project_1?.nextCursor).toBe("project_page_3")
    expect(lists.project_2?.sessions).toEqual([])
    expect(lists["sidebar:archived"]?.sessions).toEqual([])
    expect(lists["sidebar:section:pinned"]?.sessions).toEqual([])
    expect(fakeRef.current.requestsFor("session/list")).toHaveLength(listReads)
    expect(fakeRef.current.requestsFor("session/read")).toEqual([])
  })

  it("retains discovery when a previously started list response omits the new session", async () => {
    await boot()
    const staleList = deferred<{
      sessions: ApiSessionSummary[]
      nextCursor: string
    }>()
    fakeRef.current.respond = (method) =>
      method === "session/list" ? staleList.promise : independent
    const loading = useAppStore.getState().loadSessions(undefined)
    fakeRef.current.emitSidebarChanged({ sessionId: independent.id })
    await vi.waitFor(() => expect(firstRow()?.id).toBe(independent.id))
    staleList.resolve({ sessions: [session], nextCursor: "page_2" })
    await loading

    expect(
      useAppStore
        .getState()
        .sessionsByProject[""]?.sessions.map((row) => row.id),
    ).toEqual(["independent_worker", "session_1"])
    expect(useAppStore.getState().sessionsByProject[""]?.nextCursor).toBe(
      "page_2",
    )
  })

  it("excludes subagents from independent-session discovery", async () => {
    await boot()
    const hidden = sessionSummary({
      metadata: { agent: { kind: "subagent" } },
      id: "hidden_worker",
      updatedAt: independent.updatedAt,
    })
    fakeRef.current.respond = () => hidden
    fakeRef.current.emitSidebarChanged({ sessionId: hidden.id })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(
      useAppStore
        .getState()
        .sessionsByProject[""]?.sessions.map((row) => row.id),
    ).toEqual(["session_1"])
  })

  it.each([
    { patch: { archived: true }, expectedKeys: ["sidebar:archived"] },
    {
      patch: { sectionId: "pinned", sectionPosition: 1 },
      expectedKeys: ["", "sidebar:section:pinned"],
    },
  ])("respects archived and section membership for discovered sessions: $patch", async ({
    patch,
    expectedKeys,
  }) => {
    await boot([])
    useAppStore.setState({
      sessionsByProject: {
        "": { sessions: [] },
        project_1: { sessions: [] },
        "sidebar:archived": { sessions: [] },
        "sidebar:section:pinned": { sessions: [] },
      },
    })
    fakeRef.current.respond = () => ({ ...independent, ...patch })
    fakeRef.current.emitSidebarChanged({ sessionId: independent.id })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const populated = Object.entries(useAppStore.getState().sessionsByProject)
      .filter(([, list]) =>
        list.sessions.some((row) => row.id === independent.id),
      )
      .map(([key]) => key)
    expect(populated).toEqual(expectedKeys)
  })

  it("replaces a session row with its new rollout without creating a duplicate", async () => {
    await boot([sessionSummary()])
    const replacement = sessionSummary({
      rolloutId: "rollout_replacement",
      seq: 0,
      status: "idle",
      updatedAt: independent.updatedAt,
    })
    fakeRef.current.respond = () => replacement
    fakeRef.current.emitSidebarChanged({ sessionId: replacement.id })
    await vi.waitFor(() =>
      expect(firstRow()?.rolloutId).toBe("rollout_replacement"),
    )

    expect(useAppStore.getState().sessionsByProject[""]?.sessions).toEqual([
      replacement,
    ])
    expect(useAppStore.getState().sessionsByProject[""]?.nextCursor).toBe(
      "page_2",
    )
  })

  it("keeps confirmed archive membership when a summary read predates the mutation", async () => {
    const row = sessionSummary({ projectId: "project_1" })
    await boot([row])
    useAppStore.setState({
      sessionsByProject: {
        "": { sessions: [row], nextCursor: "all_page_2" },
        project_1: { sessions: [row], nextCursor: "project_page_2" },
        "sidebar:archived": { sessions: [], nextCursor: "archive_page_2" },
      },
    })
    const staleSummary = deferred<ApiSessionSummary>()
    const update = deferred<SessionSidebar>()
    fakeRef.current.respond = (method) =>
      method === "session/summary" ? staleSummary.promise : update.promise
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    const changing = useAppStore.getState().changeSidebar({
      type: "session",
      sessionId: session.id,
      archived: true,
    })
    await vi.waitFor(() =>
      expect(fakeRef.current.requestsFor("sidebar/update")).toHaveLength(1),
    )
    const sidebar: SessionSidebar = {
      sections: [],
      entries: { [session.id]: { archived: true } },
    }
    fakeRef.current.emitSidebarChanged({ sessionId: session.id, sidebar })
    update.resolve(sidebar)
    await changing
    staleSummary.resolve(row)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const lists = useAppStore.getState().sessionsByProject
    expect(lists[""]?.sessions).toEqual([])
    expect(lists.project_1?.sessions).toEqual([])
    expect(lists["sidebar:archived"]?.sessions).toMatchObject([
      { id: session.id, archived: true },
    ])
    expect(lists.project_1?.nextCursor).toBe("project_page_2")
    expect(lists["sidebar:archived"]?.nextCursor).toBe("archive_page_2")

    fakeRef.current.respond = () => ({
      ...row,
      archived: true,
      status: "waiting",
    })
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    await vi.waitFor(() =>
      expect(
        useAppStore.getState().sessionsByProject["sidebar:archived"]
          ?.sessions[0]?.status,
      ).toBe("waiting"),
    )
    expect(
      useAppStore.getState().sessionsByProject.project_1?.sessions,
    ).toEqual([])
  })

  it("keeps optimistic and confirmed pin membership when summary reads start during the mutation", async () => {
    const row = sessionSummary({ projectId: "project_1" })
    await boot([row])
    useAppStore.setState({
      sessionsByProject: {
        project_1: { sessions: [row], nextCursor: "project_page_2" },
        "sidebar:section:pinned": { sessions: [], nextCursor: "pinned_page_2" },
      },
    })
    const firstSummary = deferred<ApiSessionSummary>()
    const secondSummary = deferred<ApiSessionSummary>()
    const update = deferred<SessionSidebar>()
    let summaryReads = 0
    fakeRef.current.respond = (method) =>
      method === "sidebar/update"
        ? update.promise
        : ++summaryReads === 1
          ? firstSummary.promise
          : secondSummary.promise
    const changing = useAppStore.getState().changeSidebar({
      type: "session",
      sessionId: session.id,
      sectionId: "pinned",
    })
    await vi.waitFor(() =>
      expect(fakeRef.current.requestsFor("sidebar/update")).toHaveLength(1),
    )
    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    firstSummary.resolve(row)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      useAppStore.getState().sessionsByProject.project_1?.sessions,
    ).toEqual([])
    expect(
      useAppStore.getState().sessionsByProject["sidebar:section:pinned"]
        ?.sessions,
    ).toMatchObject([{ id: session.id, sectionId: "pinned" }])

    fakeRef.current.emitSidebarChanged({ sessionId: session.id })
    update.resolve({
      sections: [],
      entries: { [session.id]: { sectionId: "pinned", sectionPosition: 1 } },
    })
    await changing
    secondSummary.resolve(row)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const lists = useAppStore.getState().sessionsByProject
    expect(lists.project_1?.sessions).toEqual([])
    expect(lists["sidebar:section:pinned"]?.sessions).toMatchObject([
      { id: session.id, sectionId: "pinned", sectionPosition: 1 },
    ])
    expect(lists.project_1?.nextCursor).toBe("project_page_2")
    expect(lists["sidebar:section:pinned"]?.nextCursor).toBe("pinned_page_2")
  })
})
