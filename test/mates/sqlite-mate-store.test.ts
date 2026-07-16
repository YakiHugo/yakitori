import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import {
  createMateId,
  createMateKernel,
  createMateRevisionId,
  createSqliteMateStore,
  MateEventType,
  summarizeMate,
  type MateEvent,
  type SqliteMateStore,
  YakitoriErrorCode,
} from "../../src/index.ts"

describe("SQLite mate store", () => {
  it("persists identities and revisions across reopen", async () => {
    await withStores(async (context) => {
      const store = context.open()
      const kernel = createMateKernel(store)
      const created = await kernel.createMate({
        instructions: "Initial",
        name: "Momo",
        role: "Builder",
      })
      const revised = await kernel.reviseMate({
        instructions: "Revised",
        mateId: created.mate.id,
        name: "Momo",
        role: "Reviewer",
      })
      store.close()

      const reopened = context.open()
      expect(
        (await createMateKernel(reopened).readMate({ mateId: created.mate.id }))
          .mate,
      ).toEqual(revised.mate)
      expect(await reopened.listMates()).toEqual({
        mates: [summarizeMate(revised.mate)],
      })
    })
  })

  it("rejects stale appends from genuinely concurrent workers", async () => {
    await withStores(async (context) => {
      const store = context.open()
      const mateId = createMateId()
      await store.appendEvent(mateId, createdEvent(), { expectedSeq: 0 })
      const databasePath = join(context.rootDir, "events.sqlite")
      const startGate = new Int32Array(new SharedArrayBuffer(4))
      const workers = [
        createAppendWorker(databasePath, mateId, startGate.buffer),
        createAppendWorker(databasePath, mateId, startGate.buffer),
      ]
      await Promise.all(
        workers.map((worker) => waitForWorkerMessage<WorkerReady>(worker)),
      )
      const results = workers.map((worker) =>
        waitForWorkerMessage<WorkerResult>(worker),
      )
      const exits = workers.map(waitForWorkerExit)
      Atomics.store(startGate, 0, 1)
      Atomics.notify(startGate, 0, workers.length)

      const settled = await Promise.all(results)
      expect(await Promise.all(exits)).toEqual([0, 0])

      expect(settled.filter((result) => result.ok)).toHaveLength(1)
      expect(settled.filter((result) => !result.ok)).toEqual([
        { ok: false, code: YakitoriErrorCode.InvalidState },
      ])
      expect(await store.readEvents(mateId)).toHaveLength(2)
    })
  })

  it("rejects runtime event fields that could overwrite the envelope", async () => {
    await withStores(async (context) => {
      const store = context.open()
      const mateId = createMateId()
      const event = { ...createdEvent(), seq: 7 } as unknown as MateEvent

      await expect(
        store.appendEvent(mateId, event, { expectedSeq: 0 }),
      ).rejects.toThrow("Mate event is invalid.")
      expect(await store.readEvents(mateId)).toEqual([])
    })
  })

  it("paginates mate summaries and rejects invalid cursors", async () => {
    await withStores(async (context) => {
      const store = context.open()
      const mateIds = [createMateId(), createMateId()]
      await Promise.all(
        mateIds.map((mateId) =>
          store.appendEvent(mateId, createdEvent(), { expectedSeq: 0 }),
        ),
      )

      const first = await store.listMates({ limit: 1 })
      if (!first.nextCursor) throw new Error("Expected a next cursor.")
      const second = await store.listMates({
        cursor: first.nextCursor,
        limit: 1,
      })

      expect([...first.mates, ...second.mates].map((mate) => mate.id)).toEqual(
        expect.arrayContaining(mateIds),
      )
      await expect(store.listMates({ limit: 0 })).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidArgument,
      })
      await expect(
        store.listMates({ cursor: createMateId() }),
      ).rejects.toMatchObject({ code: YakitoriErrorCode.InvalidArgument })
    })
  })

  it("rejects invalid mate ids at the storage boundary", async () => {
    await withStores(async (context) => {
      await expect(
        context.open().readEvents("../../outside"),
      ).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidArgument,
      })
    })
  })
})

function createdEvent() {
  return {
    type: MateEventType.Created,
    data: {
      profile: { instructions: "Initial", name: "Momo", role: "Builder" },
      revisionId: createMateRevisionId(),
    },
  } as const
}

type WorkerReady = { readonly type: "ready" }
type WorkerResult =
  | { readonly ok: true }
  | { readonly code?: string; readonly ok: false }

function createAppendWorker(
  databasePath: string,
  mateId: string,
  startGate: SharedArrayBuffer,
): Worker {
  return new Worker(new URL("./sqlite-mate-store-worker.ts", import.meta.url), {
    workerData: { databasePath, mateId, startGate },
  })
}

function waitForWorkerMessage<T>(worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve)
    worker.once("error", reject)
  })
}

function waitForWorkerExit(worker: Worker): Promise<number> {
  return new Promise((resolve) => worker.once("exit", resolve))
}

async function withStores(
  run: (context: {
    readonly open: () => SqliteMateStore
    readonly rootDir: string
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-mates-"))
  const stores: SqliteMateStore[] = []
  try {
    await run({
      open() {
        const store = createSqliteMateStore({ rootDir })
        stores.push(store)
        return store
      },
      rootDir,
    })
  } finally {
    for (const store of stores) store.close()
    await rm(rootDir, { force: true, recursive: true })
  }
}
