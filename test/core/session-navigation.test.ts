import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { CreateThreadMetadata } from "../../src/core/thread-store.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-navigation-"))
  roots.push(root)
  const store = new JsonlThreadStore({ root })
  await store.initialize()
  return { root, store }
}
async function save(
  store: JsonlThreadStore,
  id: string,
  extra: Partial<CreateThreadMetadata> = {},
) {
  await store.createThread({
    id,
    conversationId: "shared_history",
    title: "needle",
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z",
    ...extra,
  })
  await store.shutdownThread(id)
}

describe("session navigation persistence", () => {
  it("filters agent threads before list and search pagination while preserving explicit forks", async () => {
    const { store } = await setup()
    await save(store, "session_a")
    await save(store, "session_b", { parentThreadId: "session_a" })
    await save(store, "session_z", {
      parentThreadId: "session_a",
      metadata: { agent: { kind: "subagent" } },
    })
    const first = await store.listThreads({ view: "sessions", limit: 1 })
    expect(first.threads.map((thread) => thread.id)).toEqual(["session_b"])
    if (!first.nextCursor) throw new Error("Missing list cursor")
    const second = await store.listThreads({
      view: "sessions",
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(second.threads.map((thread) => thread.id)).toEqual(["session_a"])
    expect(second.nextCursor).toBeUndefined()
    const search = await store.searchThreads({
      view: "sessions",
      searchTerm: "needle",
      limit: 1,
    })
    expect(search.matches.map(({ summary }) => summary.id)).toEqual([
      "session_b",
    ])
    if (!search.nextCursor) throw new Error("Missing search cursor")
    const more = await store.searchThreads({
      view: "sessions",
      searchTerm: "needle",
      limit: 1,
      cursor: search.nextCursor,
    })
    expect(more.matches.map(({ summary }) => summary.id)).toEqual(["session_a"])
    expect(more.nextCursor).toBeUndefined()
    expect((await store.listThreads()).threads).toHaveLength(3)
    expect(await store.readThread("session_z")).toBeDefined()
  })

  it("publishes edits only on commit and restores the committed head after restart", async () => {
    const { root, store } = await setup()
    await save(store, "session_original")
    await store.setSessionHead("session_original", "session_original")
    await save(store, "session_edit", {
      parentThreadId: "session_original",
      forkReason: "edit",
      createdAt: "2026-09-13T01:00:00Z",
    })
    expect(
      (await store.listThreads({ view: "sessions" })).threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["session_original"])
    await store.setSessionHead("session_original", "session_edit")
    await store.setSessionHead("session_edit", "session_edit")
    await save(store, "session_undo", {
      parentThreadId: "session_edit",
      forkReason: "undo",
      createdAt: "2026-09-13T02:00:00Z",
    })
    await store.setSessionHead("session_edit", "session_undo")
    // A late event on the old branch must not change the chosen edit.
    await store.resumeThread("session_original")
    await store.appendItems("session_original", [
      { type: "turn_completed", turnId: "late_turn", outcome: "completed" },
    ])
    await store.shutdownThread("session_original")
    const reopened = new JsonlThreadStore({ root })
    const page = await reopened.listThreads({ view: "sessions" })
    expect(
      page.threads.map(({ id, navigationId }) => ({ id, navigationId })),
    ).toEqual([{ id: "session_undo", navigationId: "session_original" }])
    const search = await reopened.searchThreads({
      view: "sessions",
      searchTerm: "needle",
      limit: 30,
    })
    expect(search.matches.map(({ summary }) => summary.id)).toEqual([
      "session_undo",
    ])
    expect((await reopened.listThreads()).threads).toHaveLength(3)
  })

  it("rejects a stale competing edit without replacing the winning head", async () => {
    const { root, store } = await setup()
    await save(store, "session_original")
    await store.setSessionHead("session_original", "session_original")
    await save(store, "session_a", {
      parentThreadId: "session_original",
      forkReason: "edit",
    })
    await save(store, "session_b", {
      parentThreadId: "session_original",
      forkReason: "edit",
    })
    const other = new JsonlThreadStore({ root })
    await other.initialize()
    const results = await Promise.allSettled([
      store.setSessionHead("session_original", "session_a"),
      other.setSessionHead("session_original", "session_b"),
    ])
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    const ids = (await store.listThreads({ view: "sessions" })).threads.map(
      (thread) => thread.id,
    )
    expect(ids).toEqual([
      results[0]?.status === "fulfilled" ? "session_a" : "session_b",
    ])
  })

  it("recovers existing edit history by creation order and does not resurrect it after deleting its head", async () => {
    const { root, store } = await setup()
    await save(store, "session_original", { updatedAt: "2026-09-14T00:00:00Z" })
    await save(store, "session_edit", {
      parentThreadId: "session_original",
      forkReason: "edit",
      createdAt: "2026-09-13T01:00:00Z",
    })
    expect(
      (await store.listThreads({ view: "sessions" })).threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["session_edit"])
    await store.setSessionHead("session_edit", "session_edit")
    await store.deleteThread("session_edit")
    const reopened = new JsonlThreadStore({ root })
    expect((await reopened.listThreads({ view: "sessions" })).threads).toEqual(
      [],
    )
    expect(
      (
        await reopened.searchThreads({
          view: "sessions",
          searchTerm: "needle",
          limit: 10,
        })
      ).matches,
    ).toEqual([])
    expect(await reopened.readThread("session_original")).toBeDefined()
  })
})

it("keeps names, section membership and archive state across edits, restarts and search rebuilds", async () => {
  const { root, store } = await setup()
  await save(store, "session_original")
  await save(store, "session_other")
  await store.updateSessionSidebar({
    type: "session",
    sessionId: "session_original",
    title: "Renamed conversation",
    sectionId: "pinned",
  })
  await store.setSessionHead("session_original", "session_original")
  await save(store, "session_edit", {
    parentThreadId: "session_original",
    forkReason: "edit",
  })
  await store.setSessionHead("session_original", "session_edit")
  await store.updateSessionSidebar({
    type: "session",
    sessionId: "session_edit",
    archived: true,
  })
  const restarted = new JsonlThreadStore({ root })
  expect(
    (await restarted.listThreads({ view: "sessions", limit: 1 })).threads.map(
      (s) => s.id,
    ),
  ).toEqual(["session_other"])
  const archived = await restarted.listThreads({
    view: "sessions",
    archived: true,
    sectionId: "pinned",
  })
  expect(archived.threads).toMatchObject([
    {
      id: "session_edit",
      navigationId: "session_original",
      title: "Renamed conversation",
      sectionId: "pinned",
      archived: true,
    },
  ])
  expect(
    (
      await restarted.searchThreads({
        view: "sessions",
        searchTerm: "Renamed",
        limit: 1,
      })
    ).matches,
  ).toEqual([])
  const found = await restarted.searchThreads({
    view: "sessions",
    archived: true,
    searchTerm: "Renamed",
    limit: 1,
  })
  expect(found.matches).toMatchObject([
    {
      summary: { id: "session_edit", title: "Renamed conversation" },
      snippet: "Renamed conversation",
    },
  ])
  expect(
    (
      await restarted.searchThreads({
        view: "sessions",
        archived: true,
        searchTerm: "needle",
        limit: 1,
      })
    ).matches,
  ).toEqual([])
  await restarted.updateSessionSidebar({
    type: "session",
    sessionId: "session_edit",
    archived: false,
  })
  expect(
    (
      await restarted.listThreads({ view: "sessions", sectionId: "pinned" })
    ).threads.map((s) => s.id),
  ).toEqual(["session_edit"])
  expect(
    (
      await restarted.listThreads({ view: "sessions", sectionId: null })
    ).threads.map((s) => s.id),
  ).toEqual(["session_other"])
})

it("persists independent section identities and returns members to default when a section is removed", async () => {
  const { root, store } = await setup()
  await save(store, "session_a")
  const other = new JsonlThreadStore({ root })
  await Promise.all([
    store.updateSessionSidebar({ type: "create-section", name: "Work" }),
    other.updateSessionSidebar({ type: "create-section", name: "Research" }),
  ])
  const sections = (await store.readSessionSidebar()).sections
  expect(sections.map((s) => s.name).sort()).toEqual(["Research", "Work"])
  const sectionId = sections[0]?.id
  if (!sectionId) throw new Error("Missing section")
  await store.updateSessionSidebar({
    type: "session",
    sessionId: "session_a",
    sectionId,
  })
  await other.updateSessionSidebar({
    type: "rename-section",
    sectionId,
    name: "Renamed group",
  })
  await store.updateSessionSidebar({
    type: "reorder-sections",
    sectionIds: sections.map((s) => s.id).reverse(),
  })
  expect((await other.readSessionSidebar()).sections.map((s) => s.id)).toEqual(
    sections.map((s) => s.id).reverse(),
  )
  expect(
    (await other.listThreads({ view: "sessions", sectionId })).threads,
  ).toHaveLength(1)
  await other.updateSessionSidebar({ type: "delete-section", sectionId })
  const restarted = new JsonlThreadStore({ root })
  expect(
    (
      await restarted.listThreads({ view: "sessions", sectionId: null })
    ).threads.map((s) => s.id),
  ).toEqual(["session_a"])
  expect(await restarted.readThread("session_a")).toBeDefined()
  await expect(
    restarted.updateSessionSidebar({
      type: "delete-section",
      sectionId: "pinned",
    }),
  ).rejects.toThrow("Custom section does not exist")
})

it("pages a manual section order without activity or edited execution IDs shifting the boundary", async () => {
  const { store, root } = await setup()
  for (const id of ["session_a", "session_b", "session_c", "session_d"])
    await save(store, id)
  for (const id of ["session_d", "session_c", "session_b", "session_a"])
    await store.updateSessionSidebar({
      type: "move-session",
      sessionId: id,
      sectionId: "pinned",
    })
  const first = await store.listThreads({
    view: "sessions",
    sectionId: "pinned",
    limit: 2,
  })
  expect(first.threads.map((thread) => thread.id)).toEqual([
    "session_d",
    "session_c",
  ])
  if (!first.nextCursor) throw new Error("Missing ordered cursor")
  await store.setSessionHead("session_c", "session_c")
  await save(store, "session_edit", {
    parentThreadId: "session_c",
    forkReason: "edit",
    updatedAt: "2026-01-01T00:00:00Z",
  })
  await store.setSessionHead("session_c", "session_edit")
  const reopened = new JsonlThreadStore({ root })
  const second = await reopened.listThreads({
    view: "sessions",
    sectionId: "pinned",
    limit: 2,
    cursor: first.nextCursor,
  })
  expect(second.threads.map((thread) => thread.id)).toEqual([
    "session_b",
    "session_a",
  ])
  expect(second.nextCursor).toBeUndefined()
  expect(
    (
      await reopened.listThreads({ view: "sessions", sectionId: "pinned" })
    ).threads.map((thread) => thread.id),
  ).toEqual(["session_d", "session_edit", "session_b", "session_a"])
  await reopened.updateSessionSidebar({
    type: "move-session",
    sessionId: "session_a",
    sectionId: "pinned",
    beforeSessionId: "session_d",
  })
  expect(
    (
      await reopened.listThreads({ view: "sessions", sectionId: "pinned" })
    ).threads.map((thread) => thread.id),
  ).toEqual(["session_a", "session_d", "session_edit", "session_b"])
  const before = await reopened.readSessionSidebar()
  await expect(
    reopened.updateSessionSidebar({
      type: "move-session",
      sessionId: "session_b",
      sectionId: "pinned",
      beforeSessionId: "session_c",
    }),
  ).rejects.toThrow("destination conversation changed")
  expect(await reopened.readSessionSidebar()).toEqual(before)
})

it("renumbers exhausted section positions without changing the requested order", async () => {
  const { store, root } = await setup()
  await save(store, "session_a")
  await save(store, "session_b")
  await store.updateSessionSidebar({
    type: "move-session",
    sessionId: "session_a",
    sectionId: "pinned",
  })
  await store.updateSessionSidebar({
    type: "move-session",
    sessionId: "session_b",
    sectionId: "pinned",
  })
  for (let i = 0; i < 25; i++) {
    await store.updateSessionSidebar({
      type: "move-session",
      sessionId: i % 2 === 0 ? "session_a" : "session_b",
      sectionId: "pinned",
      beforeSessionId: i % 2 === 0 ? "session_b" : "session_a",
    })
  }
  const reopened = new JsonlThreadStore({ root })
  expect(
    (
      await reopened.listThreads({ view: "sessions", sectionId: "pinned" })
    ).threads.map((thread) => thread.id),
  ).toEqual(["session_a", "session_b"])
})
