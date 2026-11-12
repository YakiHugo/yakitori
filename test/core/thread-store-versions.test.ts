import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type { RolloutItem } from "../../src/core/rollout.ts"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import {
  type CreateThreadMetadata,
  PersistContext,
  type ThreadStore,
} from "../../src/core/thread-store.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { MemoryThreadStore } from "./memory-thread-store.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe.each(["jsonl", "memory"] as const)("%s retained versions", (kind) => {
  it("retains truncated results and durable receipts without adding them to current history or explicit forks", async () => {
    const root = await temporaryRoot()
    const store: ThreadStore =
      kind === "jsonl"
        ? new JsonlThreadStore({ root })
        : new MemoryThreadStore()
    const id = "session_receipts"
    await createThread(store, id)
    await store.appendItems(id, receiptTurn("old"))
    await store.shutdownThread(id)
    const original = await store.readThread(id)
    const first = await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_old",
      expectedRolloutId: id,
    })
    expect(first.thread.metadata.previousRolloutId).toBe(id)
    expect(first.thread.metadata.historyBase).toBeUndefined()
    expect(first.thread.rollout).toHaveLength(1)
    await store.appendItems(id, receiptTurn("new"))
    await store.shutdownThread(id)
    const second = await store.revertThread({
      threadId: id,
      beforeTurnId: "turn_new",
      expectedRolloutId: first.thread.metadata.rolloutId,
    })
    await store.shutdownThread(id)

    const reader = kind === "jsonl" ? new JsonlThreadStore({ root }) : store
    const versions = await reader.readThreadVersions(id)
    expect(versions.map(({ metadata }) => metadata.rolloutId)).toEqual([
      second.thread.metadata.rolloutId,
      first.thread.metadata.rolloutId,
      id,
    ])
    expect(versions.every(({ metadata }) => metadata.id === id)).toBe(true)
    expect(versions[0]?.rollout).toHaveLength(1)
    expect(versions[1]?.rollout.map(({ item }) => item)).toContainEqual(
      expect.objectContaining({
        type: "thread_message_consumed",
        submissionId: "submission_new",
      }),
    )
    expect(versions[2]?.rollout).toEqual(original?.rollout)
    expect(versions[2]?.rollout.map(({ item }) => item)).toContainEqual(
      expect.objectContaining({
        type: "thread_message_admitted",
        sourceRequestId: "request_old",
      }),
    )
    expect(versions[2]?.rollout.map(({ item }) => item)).toContainEqual(
      expect.objectContaining({
        type: "response_item",
        item: expect.objectContaining({ id: "answer_old" }),
      }),
    )
    expect((await reader.readThread(id))?.rollout).toHaveLength(1)
    expect(
      (await reader.searchThreads({ searchTerm: "result", limit: 10 })).matches,
    ).toEqual([])
    if (kind === "jsonl") {
      expect((await readdir(join(root, "rollouts"))).sort()).toEqual(
        versions.map(({ metadata }) => metadata.rolloutId).sort(),
      )
    }

    await reader.resumeThread(id)
    await reader.appendItems(id, receiptTurn("current"))
    const prepared = await reader.prepareFork({
      sourceThreadId: id,
      boundary: { type: "latest" },
    })
    const fork = await reader.createFork({
      prepared,
      target: { ...metadata("session_fork"), parentThreadId: id },
    })
    expect(fork.thread.metadata.previousRolloutId).toBeUndefined()
    expect(await reader.readThreadVersions("session_fork")).toHaveLength(1)
    await reader.shutdownThread(id)
    await reader.shutdownThread("session_fork")
    await reader.deleteThread(id)
    expect(await reader.readThreadVersions(id)).toEqual([])
    const forkVersions = await reader.readThreadVersions("session_fork")
    expect(forkVersions).toHaveLength(1)
    expect(forkVersions[0]?.metadata.id).toBe("session_fork")
    expect(forkVersions[0]?.rollout.map(({ item }) => item)).toContainEqual(
      expect.objectContaining({
        type: "thread_message_consumed",
        submissionId: "submission_current",
      }),
    )
  })
})

it("keeps assets in fully truncated versions across restart and collection", async () => {
  const root = await temporaryRoot()
  const store = new JsonlThreadStore({ root })
  await createThread(store, "session_assets")
  const assets = createRolloutAssets(root, {
    withMutationLease: (rolloutId, mutate) =>
      store.withRolloutAssetMutation(rolloutId, mutate),
  })
  const bytes = Buffer.from("retained previous-version artifact")
  const saved = await assets.saveToolFile(
    "session_assets",
    "tool_saved",
    "output.txt",
    bytes,
  )
  await store.appendItems("session_assets", receiptTurn("asset"))
  await store.shutdownThread("session_assets")
  await store.revertThread({
    threadId: "session_assets",
    beforeTurnId: "turn_asset",
    expectedRolloutId: "session_assets",
  })
  await store.shutdownThread("session_assets")
  const reopened = new JsonlThreadStore({ root })
  expect(await reopened.readThreadVersions("session_assets")).toHaveLength(2)
  expect(await assets.read(saved.reference)).toEqual(bytes)
  await reopened.deleteThread("session_assets")
  await expect(assets.read(saved.reference)).rejects.toMatchObject({
    code: "ENOENT",
  })
})

it("rejects version cycles and links to a different session identity", async () => {
  const root = await temporaryRoot()
  const store = new JsonlThreadStore({ root })
  await createThread(store, "session_one")
  await createThread(store, "session_other")
  await store.appendItems("session_one", receiptTurn("one"))
  await store.shutdownThread("session_one")
  await store.shutdownThread("session_other")
  const result = await store.revertThread({
    threadId: "session_one",
    beforeTurnId: "turn_one",
    expectedRolloutId: "session_one",
  })
  await store.shutdownThread("session_one")
  const path = join(root, "threads", "session_one.json")
  const valid = await readFile(path, "utf8")
  await writeFile(
    path,
    JSON.stringify({
      ...result.thread.metadata,
      previousRolloutId: result.thread.metadata.rolloutId,
    }),
  )
  await expect(store.readThreadVersions("session_one")).rejects.toThrow("cycle")
  await writeFile(
    path,
    JSON.stringify({
      ...result.thread.metadata,
      previousRolloutId: "session_other",
    }),
  )
  await expect(store.readThreadVersions("session_one")).rejects.toThrow(
    "different Thread",
  )
  await writeFile(path, valid)
})

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-versions-"))
  roots.push(root)
  return root
}

function metadata(id: string): CreateThreadMetadata {
  return {
    id,
    conversationId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

async function createThread(store: ThreadStore, id: string) {
  await store.createThread(metadata(id))
  await store.persistThread(id, PersistContext.TurnStart)
}

function receiptTurn(name: string): readonly RolloutItem[] {
  const turnId = `turn_${name}`
  const receipt = {
    sourceThreadId: "session_sender",
    sourceRequestId: `request_${name}`,
    submissionId: `submission_${name}`,
    targetTurnId: turnId,
    inputItemId: `input_${name}`,
  }
  return [
    { type: "turn_started", turnId, inputItemId: receipt.inputItemId },
    {
      type: "thread_message_admitted",
      ...receipt,
      requestFingerprint: "a".repeat(64),
      input: {
        submissionId: receipt.submissionId,
        content: createUserInput(`message ${name}`),
        source: "agent",
        purpose: "task",
        provenance: {
          sourceThreadId: receipt.sourceThreadId,
          sourceRequestId: receipt.sourceRequestId,
        },
      },
      delivery: "started",
    },
    { type: "thread_message_consumed", ...receipt },
    {
      type: "response_item",
      item: {
        id: `answer_${name}`,
        turnId,
        createdAt: "2026-01-01T00:00:00.000Z",
        item: {
          role: "assistant",
          content: [{ type: "text", text: `result ${name}` }],
        },
      },
    },
    { type: "turn_completed", turnId, outcome: "completed" },
  ]
}
