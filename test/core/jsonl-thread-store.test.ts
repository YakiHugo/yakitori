import { spawn } from "node:child_process"
import {
  access,
  appendFile,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type {
  ResponseItemEnvelope,
  RolloutItem,
  ThreadMetadata,
} from "../../src/core/rollout.ts"
import type { CreateThreadMetadata } from "../../src/core/thread-store.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe("JsonlThreadStore", () => {
  it("persists ordered rollout items and resumes a single live writer", async () => {
    const { store } = await createStore()
    await store.createThread(metadata("thread_root"))
    await Promise.all([
      store.appendItems("thread_root", [response("turn_one", "one")]),
      store.appendItems("thread_root", [terminal("turn_one")]),
      store.appendItems("thread_root", [response("turn_two", "two")]),
    ])
    await store.persistThread("thread_root", "turn_start")
    await store.shutdownThread("thread_root")

    const resumed = await store.resumeThread("thread_root")
    expect(resumed?.rollout.map((entry) => entry.item.type)).toEqual([
      "session_meta",
      "response_item",
      "turn_completed",
      "response_item",
    ])
    await expect(store.resumeThread("thread_root")).rejects.toThrow(
      "live writer",
    )

    await store.appendItems("thread_root", [terminal("turn_two")])
    await store.shutdownThread("thread_root")
    expect(
      (await store.readThread("thread_root"))?.rollout.map(
        (entry) => entry.seq,
      ),
    ).toEqual([0, 1, 2, 3, 4])
  })

  it("rejects a second writer opened by another store instance", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_shared"))
    const second = new JsonlThreadStore({ root })

    await expect(second.resumeThread("thread_shared")).rejects.toThrow(
      "active writer",
    )
    await store.shutdownThread("thread_shared")
    await expect(second.resumeThread("thread_shared")).resolves.toBeDefined()
    await second.shutdownThread("thread_shared")
  })

  it("stores a fork as a history reference instead of copying source lines", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_source"))
    await store.appendItems("thread_source", [
      response("turn_one", "one"),
      terminal("turn_one"),
      response("turn_two", "two"),
      terminal("turn_two"),
    ])
    await store.flushThread("thread_source")

    const prepared = await store.prepareFork({
      sourceThreadId: "thread_source",
      boundary: { type: "before_turn", turnId: "turn_two" },
    })
    const fork = await store.createFork({
      prepared,
      target: metadata("thread_child", {
        parentThreadId: "thread_source",
        forkedFromTurnId: "turn_two",
      }),
    })

    const childLines = (
      await readFile(join(root, "rollouts", "thread_child.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
    expect(childLines).toHaveLength(1)
    expect(fork.thread.metadata.historyBase).toEqual({
      rolloutId: "thread_source",
      endSeqExclusive: 3,
      endByteOffset: expect.any(Number),
    })
    expect(
      fork.thread.rollout.flatMap((entry) =>
        entry.item.type === "response_item" ? [entry.item.item.turnId] : [],
      ),
    ).toEqual(["turn_one"])
    await store.shutdownThread("thread_child")
    await store.shutdownThread("thread_source")
  })

  it("rejects forged lineage fields on an empty-history fork target", async () => {
    const { store } = await createStore()
    await store.createThread(metadata("thread_empty_source"))
    const prepared = await store.prepareFork({
      sourceThreadId: "thread_empty_source",
      boundary: { type: "latest" },
    })
    expect(prepared.historyPosition).toBeUndefined()
    const forged: ThreadMetadata = {
      ...metadata("thread_forged_child"),
      rolloutId: "rollout_forged_child",
      historyBase: {
        rolloutId: "rollout_unreserved",
        endSeqExclusive: 2,
        endByteOffset: 100,
      },
    }

    await expect(
      store.createFork({ prepared, target: forged }),
    ).rejects.toThrow("cannot provide physical rollout or inherited history")
    await store.releasePreparedFork(prepared)
    await store.shutdownThread("thread_empty_source")
  })

  it("rejects inherited history and physical identity outside the fork protocol", async () => {
    const { root, store } = await createStore()
    const forged: ThreadMetadata = {
      ...metadata("thread_forged"),
      rolloutId: "rollout_forged",
      historyBase: {
        rolloutId: "rollout_source",
        endSeqExclusive: 2,
        endByteOffset: 100,
      },
    }
    await expect(store.createThread(forged)).rejects.toThrow(
      "cannot provide physical rollout or inherited history",
    )
    await expect(
      access(join(root, "threads", "thread_forged.json")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps referenced rollout history after deleting the visible source thread", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_source"))
    await store.appendItems("thread_source", [
      response("turn_one", "one"),
      terminal("turn_one"),
    ])
    const prepared = await store.prepareFork({
      sourceThreadId: "thread_source",
      boundary: { type: "latest" },
    })
    await store.createFork({
      prepared,
      target: metadata("thread_child", { parentThreadId: "thread_source" }),
    })
    await store.shutdownThread("thread_source")

    await store.deleteThread("thread_source")
    expect(await store.readThread("thread_source")).toBeUndefined()
    expect(
      (await store.readThread("thread_child"))?.rollout.some(
        (entry) =>
          entry.item.type === "response_item" &&
          entry.item.item.turnId === "turn_one",
      ),
    ).toBe(true)
    await expect(
      access(join(root, "rollouts", "thread_source.jsonl")),
    ).resolves.toBeUndefined()

    await store.shutdownThread("thread_child")
    await store.deleteThread("thread_child")
    await expect(
      access(join(root, "rollouts", "thread_source.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("holds and releases a source deletion reservation around fork preparation", async () => {
    const { store } = await createStore()
    await store.createThread(metadata("thread_source"))
    await store.shutdownThread("thread_source")
    const prepared = await store.prepareFork({
      sourceThreadId: "thread_source",
      boundary: { type: "latest" },
    })

    await expect(store.deleteThread("thread_source")).rejects.toThrow(
      "active fork reservation",
    )
    await store.releasePreparedFork(prepared)
    await store.deleteThread("thread_source")
    expect(await store.readThread("thread_source")).toBeUndefined()
  })

  it("prepares bounded model context after compaction replacement", async () => {
    const { store } = await createStore()
    await store.createThread(metadata("thread_source"))
    const replacement = response("turn_summary", "summary")
    const later = response("turn_later", "later")
    await store.appendItems("thread_source", [
      response("turn_old", "old"),
      {
        type: "compacted",
        turnId: "turn_old",
        replacement: [replacement.item],
        summary: "summary",
      },
      later,
    ])

    const prepared = await store.prepareFork({
      sourceThreadId: "thread_source",
      boundary: { type: "latest" },
    })
    expect(prepared.modelContext.map((item) => item.turnId)).toEqual([
      "turn_summary",
      "turn_later",
    ])
    await store.releasePreparedFork(prepared)
    await store.shutdownThread("thread_source")
  })

  it("repairs an incomplete trailing JSON line before resuming appends", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_recover"))
    await store.appendItems("thread_recover", [response("turn_one", "one")])
    await store.shutdownThread("thread_recover")
    const rolloutPath = join(root, "rollouts", "thread_recover.jsonl")
    await appendFile(rolloutPath, '{"threadId":"partial')

    const resumed = await store.resumeThread("thread_recover")
    expect(resumed?.rollout).toHaveLength(2)
    await store.appendItems("thread_recover", [terminal("turn_one")])
    await store.shutdownThread("thread_recover")

    expect(
      (await store.readThread("thread_recover"))?.rollout.map(
        (entry) => entry.item.type,
      ),
    ).toEqual(["session_meta", "response_item", "turn_completed"])
  })

  it("resolves multi-generation lineage using physical history positions", async () => {
    const { store } = await createStore()
    await store.createThread(metadata("thread_root"))
    await store.appendItems("thread_root", [
      response("turn_root", "root"),
      terminal("turn_root"),
    ])
    const childPrepared = await store.prepareFork({
      sourceThreadId: "thread_root",
      boundary: { type: "latest" },
    })
    await store.createFork({
      prepared: childPrepared,
      target: metadata("thread_child", { parentThreadId: "thread_root" }),
    })
    await store.appendItems("thread_child", [
      response("turn_child", "child"),
      terminal("turn_child"),
    ])
    const grandchildPrepared = await store.prepareFork({
      sourceThreadId: "thread_child",
      boundary: { type: "latest" },
    })
    const grandchild = await store.createFork({
      prepared: grandchildPrepared,
      target: metadata("thread_grandchild", {
        parentThreadId: "thread_child",
      }),
    })

    expect(grandchild.thread.metadata.historyBase).toEqual({
      rolloutId: "thread_child",
      endSeqExclusive: 5,
      endByteOffset: expect.any(Number),
    })
    expect(
      grandchild.thread.rollout.flatMap((entry) =>
        entry.item.type === "response_item" ? [entry.item.item.turnId] : [],
      ),
    ).toEqual(["turn_root", "turn_child"])

    await store.shutdownThread("thread_grandchild")
    await store.shutdownThread("thread_child")
    await store.shutdownThread("thread_root")
    await store.deleteThread("thread_root")
    await store.deleteThread("thread_child")
    expect(
      (await store.readThread("thread_grandchild"))?.rollout.flatMap((entry) =>
        entry.item.type === "response_item" ? [entry.item.item.turnId] : [],
      ),
    ).toEqual(["turn_root", "turn_child"])
  })

  it("shares shutdown completion and closes writer admission immediately", async () => {
    const { store } = await createStore()
    await store.createThread(metadata("thread_shutdown"))

    const first = store.shutdownThread("thread_shutdown")
    const second = store.shutdownThread("thread_shutdown")
    expect(() =>
      store.appendItems("thread_shutdown", [response("turn_late", "late")]),
    ).toThrow("closing")
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })

  it("keeps the writer and pending suffix retryable when shutdown persistence fails", async () => {
    const root = await createRoot()
    expect(await runShutdownSyncFailureProbe(root)).toBe("sync failed")
    const store = new JsonlThreadStore({ root })
    expect(
      (await store.readThread("thread_retry_shutdown"))?.rollout.some(
        (entry) =>
          entry.item.type === "response_item" &&
          entry.item.item.turnId === "turn_retry",
      ),
    ).toBe(true)
  })

  it("truncates an unknown partial write before replaying the semantic item", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_partial_retry"))
    const probe = await open(join(root, "probe-write"), "w+")
    const prototype = Object.getPrototypeOf(probe) as {
      write(
        buffer: Buffer,
        offset: number,
        length: number,
      ): Promise<{ readonly bytesWritten: number; readonly buffer: Buffer }>
    }
    const originalWrite = prototype.write
    let injectPartialFailure = true
    prototype.write = async function write(buffer, offset, length) {
      if (injectPartialFailure) {
        injectPartialFailure = false
        await originalWrite.call(this, buffer, offset, Math.min(length, 17))
        throw new Error("write failed after an unknown partial append")
      }
      return originalWrite.call(this, buffer, offset, length)
    }

    try {
      await store.appendItems("thread_partial_retry", [
        response("turn_partial", "partial"),
      ])
    } finally {
      prototype.write = originalWrite
      await probe.close()
    }
    await store.shutdownThread("thread_partial_retry")

    expect(
      (await store.readThread("thread_partial_retry"))?.rollout.flatMap(
        (entry) =>
          entry.item.type === "response_item" ? [entry.item.item.turnId] : [],
      ),
    ).toEqual(["turn_partial"])
  })

  it("does not duplicate a record when write completion is reported as failure", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_ack_lost"))
    const probe = await open(join(root, "probe-ack-lost"), "w+")
    const prototype = Object.getPrototypeOf(probe) as {
      write(
        buffer: Buffer,
        offset: number,
        length: number,
      ): Promise<{ readonly bytesWritten: number; readonly buffer: Buffer }>
    }
    const originalWrite = prototype.write
    let loseAcknowledgement = true
    prototype.write = async function write(buffer, offset, length) {
      const result = await originalWrite.call(this, buffer, offset, length)
      if (loseAcknowledgement) {
        loseAcknowledgement = false
        throw new Error("write completed but acknowledgement was lost")
      }
      return result
    }

    try {
      await store.appendItems("thread_ack_lost", [
        response("turn_once", "once"),
      ])
    } finally {
      prototype.write = originalWrite
      await probe.close()
    }
    await store.shutdownThread("thread_ack_lost")

    expect(
      (await store.readThread("thread_ack_lost"))?.rollout.flatMap((entry) =>
        entry.item.type === "response_item" ? [entry.item.item.turnId] : [],
      ),
    ).toEqual(["turn_once"])
  })

  it.each([
    ["temporary file sync", 1],
    ["rollout directory sync", 2],
    ["metadata directory sync", 4],
  ])("rolls creation back after %s fails", async (_label, failAtSync) => {
    const root = await createRoot()
    expect(await runCreateSyncFailureProbe(root, failAtSync)).toBe(
      "injected create sync failure",
    )
    expect(await readdir(join(root, "threads"))).toEqual([])
    expect(await readdir(join(root, "rollouts"))).toEqual([])

    const store = new JsonlThreadStore({ root })
    await expect(
      store.createThread(metadata("thread_create_retry")),
    ).resolves.toBeDefined()
    await store.shutdownThread("thread_create_retry")
  })

  it("enforces writer and reservation ownership across processes", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_process"))

    expect(await runStoreProbe(root, "thread_process")).toEqual({
      resume: "Thread thread_process already has an active writer.",
      delete: "Thread thread_process still has a live writer.",
    })
    await store.shutdownThread("thread_process")
    const prepared = await store.prepareFork({
      sourceThreadId: "thread_process",
      boundary: { type: "latest" },
    })
    expect((await runStoreProbe(root, "thread_process", false)).delete).toBe(
      "Thread thread_process has an active fork reservation.",
    )
    await store.releasePreparedFork(prepared)
  })

  it("preserves a valid trailing record that only lacks its newline", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_valid_tail"))
    await store.appendItems("thread_valid_tail", [response("turn_one", "one")])
    await store.shutdownThread("thread_valid_tail")
    const rolloutPath = join(root, "rollouts", "thread_valid_tail.jsonl")
    const bytes = await readFile(rolloutPath)
    await writeFile(rolloutPath, bytes.subarray(0, bytes.length - 1))

    expect(
      (await store.resumeThread("thread_valid_tail"))?.rollout.map(
        (entry) => entry.item.type,
      ),
    ).toEqual(["session_meta", "response_item"])
    await store.shutdownThread("thread_valid_tail")
  })

  it("rejects complete local journal gaps instead of appending past corruption", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_corrupt"))
    await store.appendItems("thread_corrupt", [response("turn_one", "one")])
    await store.shutdownThread("thread_corrupt")
    const rolloutPath = join(root, "rollouts", "thread_corrupt.jsonl")
    const lines = (await readFile(rolloutPath, "utf8")).trim().split("\n")
    const duplicate = JSON.parse(lines[1] ?? "null") as Record<string, unknown>
    duplicate.seq = 3
    await appendFile(rolloutPath, `${JSON.stringify(duplicate)}\n`)

    await expect(store.resumeThread("thread_corrupt")).rejects.toThrow(
      "invalid local ordering",
    )
  })

  it("rejects malformed model messages at the journal read boundary", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_malformed_message"))
    await store.shutdownThread("thread_malformed_message")
    await appendFile(
      join(root, "rollouts", "thread_malformed_message.jsonl"),
      `${JSON.stringify({
        threadId: "thread_malformed_message",
        rolloutId: "thread_malformed_message",
        seq: 1,
        createdAt: new Date().toISOString(),
        item: {
          type: "response_item",
          item: {
            id: "message_malformed",
            turnId: "turn_malformed",
            createdAt: new Date().toISOString(),
            item: { role: "tool", content: "missing tool call identity" },
          },
        },
      })}\n`,
    )

    await expect(store.readThread("thread_malformed_message")).rejects.toThrow(
      "contains an invalid item",
    )
  })

  it("uses original BeforeTurn and newest ThroughTurn occurrences", async () => {
    const { store } = await createStore()
    await store.createThread(metadata("thread_boundary"))
    await store.appendItems("thread_boundary", [
      response("turn_repeat", "first"),
      terminal("turn_repeat"),
      response("turn_repeat", "second"),
      terminal("turn_repeat"),
    ])

    const before = await store.prepareFork({
      sourceThreadId: "thread_boundary",
      boundary: { type: "before_turn", turnId: "turn_repeat" },
    })
    expect(before.historyPosition).toBeUndefined()
    await store.releasePreparedFork(before)
    const through = await store.prepareFork({
      sourceThreadId: "thread_boundary",
      boundary: { type: "through_turn", turnId: "turn_repeat" },
    })
    expect(through.historyPosition?.endSeqExclusive).toBe(5)
    await store.releasePreparedFork(through)
    await store.shutdownThread("thread_boundary")
  })

  it("keeps healthy Threads listable when an index points to no rollout", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_healthy"))
    await writeFile(
      join(root, "threads", "thread_phantom.json"),
      `${JSON.stringify({
        ...metadata("thread_phantom"),
        rolloutId: "rollout_missing",
      })}\n`,
    )

    expect(
      (await store.listThreads()).threads.map((thread) => thread.id),
    ).toEqual(["thread_healthy"])
    await store.shutdownThread("thread_healthy")
  })

  it("starts with a damaged index without deleting healthy rollout state", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_healthy_restart"))
    await store.appendItems("thread_healthy_restart", [
      response("turn_healthy", "healthy"),
    ])
    await store.shutdownThread("thread_healthy_restart")
    await writeFile(join(root, "threads", "thread_damaged.json"), '{"id":')

    const restarted = new JsonlThreadStore({ root })
    expect(
      (await restarted.listThreads()).threads.map((thread) => thread.id),
    ).toEqual(["thread_healthy_restart"])
    expect(
      (await restarted.readThread("thread_healthy_restart"))?.rollout.flatMap(
        (entry) =>
          entry.item.type === "response_item" ? [entry.item.item.turnId] : [],
      ),
    ).toEqual(["turn_healthy"])
  })

  it("rejects path traversal identities from persisted metadata", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_traversal"))
    await store.shutdownThread("thread_traversal")
    const metadataPath = join(root, "threads", "thread_traversal.json")
    const persisted = JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as Record<string, unknown>
    persisted.rolloutId = "../../outside"
    await writeFile(metadataPath, `${JSON.stringify(persisted)}\n`)

    const restarted = new JsonlThreadStore({ root })
    await expect(restarted.readThread("thread_traversal")).rejects.toThrow(
      "invalid metadata",
    )
    await expect(restarted.resumeThread("thread_traversal")).rejects.toThrow(
      "invalid metadata",
    )
  })

  it("keeps healthy Threads available when another retained rollout is corrupt", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_healthy_rollout"))
    await store.createThread(metadata("thread_broken_rollout"))
    await store.shutdownThread("thread_healthy_rollout")
    await store.shutdownThread("thread_broken_rollout")
    const brokenPath = join(root, "rollouts", "thread_broken_rollout.jsonl")
    await appendFile(
      brokenPath,
      `${JSON.stringify({
        threadId: "thread_broken_rollout",
        rolloutId: "thread_broken_rollout",
        seq: 3,
        createdAt: new Date().toISOString(),
        item: response("turn_gap", "gap"),
      })}\n`,
    )

    const restarted = new JsonlThreadStore({ root })
    expect(
      (await restarted.listThreads()).threads.map((thread) => thread.id),
    ).toEqual(["thread_healthy_rollout"])
    await expect(
      restarted.readThread("thread_healthy_rollout"),
    ).resolves.toBeDefined()
    await expect(restarted.readThread("thread_broken_rollout")).rejects.toThrow(
      "invalid local ordering",
    )
  })

  it("waits for storage coordination during startup instead of rejecting readiness", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_coordinated"))
    await store.shutdownThread("thread_coordinated")
    const heldLock = await holdStorageLock(root)
    const competing = new JsonlThreadStore({ root })
    let settled = false
    const listing = competing.listThreads().finally(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(settled).toBe(false)
    heldLock.release()
    await expect(listing).resolves.toMatchObject({
      threads: [{ id: "thread_coordinated" }],
    })
    await heldLock.exited
  })

  it("does not delete an existing target when fork creation collides", async () => {
    const { store } = await createStore()
    await store.createThread(metadata("thread_source"))
    await store.createThread(metadata("thread_target"))
    const prepared = await store.prepareFork({
      sourceThreadId: "thread_source",
      boundary: { type: "latest" },
    })

    await expect(
      store.createFork({ prepared, target: metadata("thread_target") }),
    ).rejects.toThrow()
    expect(await store.readThread("thread_target")).toBeDefined()
    await store.releasePreparedFork(prepared)
    await store.shutdownThread("thread_target")
    await store.shutdownThread("thread_source")
  })

  it("rejects a forged byte cutoff instead of silently widening history", async () => {
    const { root, store } = await createStore()
    await store.createThread(metadata("thread_source"))
    await store.appendItems("thread_source", [response("turn_one", "one")])
    const prepared = await store.prepareFork({
      sourceThreadId: "thread_source",
      boundary: { type: "latest" },
    })
    await store.createFork({
      prepared,
      target: metadata("thread_child", { parentThreadId: "thread_source" }),
    })
    await store.shutdownThread("thread_child")
    const childPath = join(root, "rollouts", "thread_child.jsonl")
    const childMeta = JSON.parse(
      (await readFile(childPath, "utf8")).trim(),
    ) as {
      item: { metadata: { historyBase: { endByteOffset: number } } }
    }
    childMeta.item.metadata.historyBase.endByteOffset += 1
    await writeFile(childPath, `${JSON.stringify(childMeta)}\n`)

    await expect(store.readThread("thread_child")).rejects.toThrow(
      "invalid cutoff position",
    )
    await store.shutdownThread("thread_source")
  })
})

async function createStore() {
  const root = await createRoot()
  return { root, store: new JsonlThreadStore({ root }) }
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-thread-store-"))
  roots.push(root)
  return root
}

async function runStoreProbe(
  root: string,
  threadId: string,
  probeResume = true,
) {
  const moduleUrl = new URL(
    "../../src/core/jsonl-thread-store.ts",
    import.meta.url,
  ).href
  const script = `
    import { JsonlThreadStore } from ${JSON.stringify(moduleUrl)};
    const store = new JsonlThreadStore({ root: ${JSON.stringify(root)} });
    const result = {};
    if (${JSON.stringify(probeResume)}) {
      try { await store.resumeThread(${JSON.stringify(threadId)}); result.resume = "opened"; }
      catch (error) { result.resume = error instanceof Error ? error.message : "failed"; }
    }
    try { await store.deleteThread(${JSON.stringify(threadId)}); result.delete = "deleted"; }
    catch (error) { result.delete = error instanceof Error ? error.message : "failed"; }
    process.stdout.write(JSON.stringify(result));
  `
  return new Promise<{ readonly resume?: string; readonly delete: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { stdio: ["ignore", "pipe", "pipe"] },
      )
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk
      })
      child.on("error", reject)
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(stderr))
        else resolve(JSON.parse(stdout))
      })
    },
  )
}

async function runShutdownSyncFailureProbe(root: string): Promise<string> {
  const moduleUrl = new URL(
    "../../src/core/jsonl-thread-store.ts",
    import.meta.url,
  ).href
  const script = `
    import { open } from "node:fs/promises";
    import { JsonlThreadStore } from ${JSON.stringify(moduleUrl)};
    const store = new JsonlThreadStore({ root: ${JSON.stringify(root)} });
    const now = new Date().toISOString();
    await store.createThread({ id: "thread_retry_shutdown", conversationId: "thread_retry_shutdown", createdAt: now, updatedAt: now });
    await store.appendItems("thread_retry_shutdown", [${JSON.stringify(response("turn_retry", "retry"))}]);
    const probe = await open(${JSON.stringify(join(root, "probe-shutdown-sync"))}, "w+");
    const prototype = Object.getPrototypeOf(probe);
    const originalSync = prototype.sync;
    let failures = 3;
    prototype.sync = async function sync() {
      if (failures > 0) { failures -= 1; throw new Error("sync failed"); }
      await originalSync.call(this);
    };
    let message = "no failure";
    try { await store.shutdownThread("thread_retry_shutdown"); }
    catch (error) { message = error instanceof Error ? error.message : "unknown failure"; }
    prototype.sync = originalSync;
    await probe.close();
    await store.shutdownThread("thread_retry_shutdown");
    process.stdout.write(message);
  `
  return runScriptProbe(script)
}

async function runCreateSyncFailureProbe(
  root: string,
  failAtSync: number,
): Promise<string> {
  const moduleUrl = new URL(
    "../../src/core/jsonl-thread-store.ts",
    import.meta.url,
  ).href
  const script = `
    import { open } from "node:fs/promises";
    import { JsonlThreadStore } from ${JSON.stringify(moduleUrl)};
    const store = new JsonlThreadStore({ root: ${JSON.stringify(root)} });
    const probe = await open(${JSON.stringify(join(root, "probe-create-sync"))}, "w+");
    const prototype = Object.getPrototypeOf(probe);
    const originalSync = prototype.sync;
    let syncCount = 0;
    prototype.sync = async function sync() {
      syncCount += 1;
      if (syncCount === ${JSON.stringify(failAtSync)}) throw new Error("injected create sync failure");
      await originalSync.call(this);
    };
    const now = new Date().toISOString();
    let message = "no failure";
    try { await store.createThread({ id: "thread_create_retry", conversationId: "thread_create_retry", createdAt: now, updatedAt: now }); }
    catch (error) { message = error instanceof Error ? error.message : "unknown failure"; }
    prototype.sync = originalSync;
    await probe.close();
    process.stdout.write(message);
  `
  return runScriptProbe(script)
}

function runScriptProbe(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr))
    })
  })
}

async function holdStorageLock(root: string): Promise<{
  readonly release: () => void
  readonly exited: Promise<void>
}> {
  const script = `
    import { open } from "node:fs/promises";
    import { flock } from "fs-ext";
    const file = await open(${JSON.stringify(join(root, "locks", "storage.lock"))}, "a+");
    await new Promise((resolve, reject) => flock(file.fd, "ex", (error) => error === null ? resolve() : reject(error)));
    process.stdout.write("ready\\n");
    process.stdin.once("data", async () => {
      await new Promise((resolve, reject) => flock(file.fd, "un", (error) => error === null ? resolve() : reject(error)));
      await file.close();
      process.exit(0);
    });
  `
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  await new Promise<void>((resolve, reject) => {
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.stdout.setEncoding("utf8").once("data", (chunk: string) => {
      if (chunk === "ready\n") resolve()
      else reject(new Error(`Unexpected lock probe output: ${chunk}${stderr}`))
    })
  })
  return {
    release: () => child.stdin.end("release\n"),
    exited: new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Storage lock probe exited ${code}.`))
      })
    }),
  }
}

function metadata(
  id: string,
  extra: Partial<CreateThreadMetadata> = {},
): CreateThreadMetadata {
  const now = new Date().toISOString()
  return {
    id,
    conversationId: id,
    createdAt: now,
    updatedAt: now,
    ...extra,
  }
}

function response(
  turnId: string,
  text: string,
): Extract<RolloutItem, { readonly type: "response_item" }> {
  const item: ResponseItemEnvelope = {
    id: `message_${turnId}`,
    turnId,
    createdAt: new Date().toISOString(),
    item: { role: "user", content: [{ type: "text", text }] },
  }
  return { type: "response_item", item }
}

function terminal(turnId: string): RolloutItem {
  return { type: "turn_completed", turnId, outcome: "completed" }
}
