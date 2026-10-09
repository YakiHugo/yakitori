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
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { requireStoredAssetSource } from "../../src/core/asset-types.ts"
import { ContextManager } from "../../src/core/context-manager.ts"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import type {
  ResponseItemEnvelope,
  RolloutItem,
  ThreadMetadata,
} from "../../src/core/rollout.ts"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import type { CreateThreadMetadata } from "../../src/core/thread-store.ts"
import { YakitoriErrorCode } from "../../src/kernel/errors.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe("JsonlThreadStore", () => {
  it("retains full tool results and rebuilds their captured history budget on resume", async () => {
    const { root, store } = await createStore()
    const id = "thread_tool_history"
    await createPersistentThread(store, metadata(id))
    const result: ResponseItemEnvelope = {
      id: "result",
      turnId: "turn",
      createdAt: "2026-10-07T00:00:00Z",
      historyOutputBudget: { maxBytes: 64, maxLines: 4 },
      toolContentBlockCount: 1,
      item: {
        role: "tool",
        toolCallId: "read",
        content: [
          { type: "text", text: "complete file" },
          { type: "text", text: "hook context\n".repeat(100) },
        ],
        fileObservations: [
          { path: "source.ts", kind: "whole_file_read", complete: true },
        ],
      },
    }
    const append = await store.appendItems(id, [
      { type: "response_item", item: result },
    ])
    expect(append.throughSeq).toBe(2)
    const stored = await store.readThread(id)
    expect(append.records).toEqual(stored?.rollout.slice(1))
    expect(append.records[0]?.item).toEqual({
      type: "response_item",
      item: result,
    })
    const live = new ContextManager()
    live.record([result])
    await store.shutdownThread(id)
    const reopened = new JsonlThreadStore({ root })
    const restored = await reopened.resumeThread(id)
    if (restored === undefined) throw new Error("Missing tool history")
    expect(restored.rollout[1]?.item).toEqual({
      type: "response_item",
      item: result,
    })
    const history = ContextManager.fromStoredThread(restored).snapshot().history
    expect(history).toEqual(live.snapshot().history)
    expect(history[0]?.item).toMatchObject({
      fileObservations: [
        { path: "source.ts", kind: "whole_file_read", complete: true },
      ],
      content: [
        { type: "text", text: "complete file" },
        { type: "text", text: expect.stringContaining("[Output truncated.]") },
      ],
    })
    await reopened.shutdownThread(id)
  })

  it.each([
    "response_item",
    "agent_message",
    "compacted",
  ] as const)("reads the shipped tool text/media shape in %s without rewriting or losing ownership", async (type) => {
    const { root, store } = await createStore()
    const id = `thread_saved_tool_${type}`
    await createPersistentThread(store, metadata(id))
    const assets = createStoreAssets(root, store)
    const saved = await assets.saveToolFile(
      id,
      "saved_tool",
      "image.png",
      pngBytes(),
    )
    await store.shutdownThread(id)
    const image = {
      type: "image",
      mediaType: "image/png",
      file: saved.reference,
      sizeBytes: pngBytes().length,
    }
    const tool = {
      role: "tool",
      toolCallId: "saved_tool",
      content: "saved output",
      images: [image],
      documents: [],
      isError: true,
      fileObservations: [
        { path: "source.ts", kind: "whole_file_read", complete: true },
      ],
      toolSearch: { tools: [] },
    }
    const envelope = {
      id: "saved_result",
      turnId: "saved_turn",
      createdAt: "2026-09-07T00:00:00Z",
      item: tool,
    }
    const item =
      type === "compacted"
        ? {
            type,
            turnId: "saved_turn",
            summary: "checkpoint",
            replacement: [envelope],
          }
        : {
            type,
            item: envelope,
            ...(type === "agent_message" ? { messageId: "saved_message" } : {}),
          }
    const path = join(root, "rollouts", id, "rollout.jsonl")
    const raw = JSON.stringify({
      threadId: id,
      rolloutId: id,
      seq: 1,
      createdAt: envelope.createdAt,
      item,
    })
    await appendFile(path, raw)
    const reopened = new JsonlThreadStore({ root })
    const restored = await reopened.resumeThread(id)
    if (restored === undefined) throw new Error("Missing saved tool history")
    const history = ContextManager.fromStoredThread(restored).snapshot().history
    expect(history).toEqual([
      {
        ...envelope,
        item: {
          role: "tool",
          toolCallId: "saved_tool",
          isError: true,
          content: [{ type: "text", text: "saved output" }, image],
          fileObservations: tool.fileObservations,
          toolSearch: { tools: [] },
        },
      },
    ])
    expect(
      await createStoreAssets(root, reopened).read(saved.reference),
    ).toEqual(pngBytes())
    expect((await readFile(path, "utf8")).endsWith(`${raw}\n`)).toBe(true)
    await reopened.shutdownThread(id)
    const reread = await new JsonlThreadStore({ root }).readThread(id)
    expect(
      reread && ContextManager.fromStoredThread(reread).snapshot().history,
    ).toEqual(history)
  })

  it.each([
    { content: "old", images: [{ type: "text", text: "invalid image" }] },
    { content: "old", documents: [{ type: "text", text: "invalid PDF" }] },
    { content: [{ type: "text", text: "new" }], images: [] },
  ])("rejects malformed or ambiguous saved tool media: %j", async (shape) => {
    const { root, store } = await createStore()
    const id = "thread_bad_tool"
    await createPersistentThread(store, metadata(id))
    await store.shutdownThread(id)
    const path = join(root, "rollouts", id, "rollout.jsonl")
    const raw = JSON.stringify({
      threadId: id,
      rolloutId: id,
      seq: 1,
      createdAt: "2026-09-07T00:00:00Z",
      item: {
        type: "response_item",
        item: {
          id: "bad",
          turnId: "turn",
          createdAt: "2026-09-07T00:00:00Z",
          item: {
            role: "tool",
            toolCallId: "saved_tool",
            ...shape,
          },
        },
      },
    })
    await appendFile(path, `${raw}\n`)
    await expect(new JsonlThreadStore({ root }).readThread(id)).rejects.toThrow(
      "contains an invalid item",
    )
    expect((await readFile(path, "utf8")).endsWith(`${raw}\n`)).toBe(true)
  })

  it.each([
    "response_item",
    "agent_message",
    "compacted",
  ] as const)("normalizes saved text-plus-images in %s without rewriting media or the stored record", async (type) => {
    const { root, store } = await createStore()
    const id = `thread_legacy_${type}`
    await createPersistentThread(store, metadata(id))
    const assets = createStoreAssets(root, store)
    const staged = await assets.importAttachmentBytes(id, "original", [
      { name: "saved.png", data: pngBytes() },
    ])
    const {
      attachments: [attachment],
    } = await assets.promoteAttachments(id, "saved", staged)
    if (attachment === undefined) throw new Error("Missing fixture image")
    await store.shutdownThread(id)
    const image = {
      type: "image",
      mediaType: attachment.mediaType,
      file: attachment.file,
      sizeBytes: attachment.sizeBytes,
      name: attachment.name,
      detail: "original",
    }
    const envelope = {
      id: "saved_user",
      turnId: "saved_turn",
      createdAt: "2026-09-07T00:00:00Z",
      item: {
        role: "user",
        content: [{ type: "text", text: "saved request" }],
        images: [image],
      },
      submissionMetadata: { metadata: { source: "user" } },
    }
    const item =
      type === "compacted"
        ? {
            type,
            turnId: "saved_turn",
            summary: "saved checkpoint",
            replacement: [envelope],
          }
        : {
            type,
            item: envelope,
            ...(type === "agent_message" ? { messageId: "saved_message" } : {}),
          }
    const path = join(root, "rollouts", id, "rollout.jsonl")
    // A complete final record without a newline exercises resume's tail repair.
    const raw = JSON.stringify({
      threadId: id,
      rolloutId: id,
      seq: 1,
      createdAt: "2026-09-07T00:00:00Z",
      item,
    })
    await appendFile(path, raw)
    const reopened = new JsonlThreadStore({ root })
    const restored = await reopened.resumeThread(id)
    if (restored === undefined) throw new Error("Missing restored thread")
    const history = ContextManager.fromStoredThread(restored).snapshot().history
    expect(history).toEqual([
      {
        ...envelope,
        item: {
          role: "user",
          content: [{ type: "text", text: "saved request" }, image],
        },
      },
    ])
    expect(
      await createStoreAssets(root, reopened).read(attachment.file),
    ).toEqual(pngBytes())
    expect((await readFile(path, "utf8")).endsWith(`${raw}\n`)).toBe(true)
    await reopened.shutdownThread(id)
    const reread = await new JsonlThreadStore({ root }).readThread(id)
    expect(
      reread && ContextManager.fromStoredThread(reread).snapshot().history,
    ).toEqual(history)
  })

  it("rejects non-image entries in saved image arrays without turning them into user text", async () => {
    const { root, store } = await createStore()
    const id = "thread_invalid_legacy_image"
    await createPersistentThread(store, metadata(id))
    await store.shutdownThread(id)
    const path = join(root, "rollouts", id, "rollout.jsonl")
    const raw = JSON.stringify({
      threadId: id,
      rolloutId: id,
      seq: 1,
      createdAt: "2026-09-07T00:00:00Z",
      item: {
        type: "response_item",
        item: {
          id: "invalid_user",
          turnId: "saved_turn",
          createdAt: "2026-09-07T00:00:00Z",
          item: {
            role: "user",
            content: [{ type: "text", text: "saved request" }],
            images: [{ type: "text", text: "not an image" }],
          },
        },
      },
    })
    await appendFile(path, `${raw}\n`)
    await expect(new JsonlThreadStore({ root }).readThread(id)).rejects.toThrow(
      "contains an invalid item",
    )
    expect((await readFile(path, "utf8")).endsWith(`${raw}\n`)).toBe(true)
  })

  it("round-trips canonical image/text/image content through reload and checkpoint replacement", async () => {
    const { root, store } = await createStore()
    const id = "thread_ordered_content"
    await createPersistentThread(store, metadata(id))
    const assets = createStoreAssets(root, store)
    const firstBytes = pngBytes()
    const secondBytes = Buffer.from(
      "ffd8ffc00011080001000103011100021100031100ffd9",
      "hex",
    )
    const drafts = await assets.importAttachmentBytes(id, "ordered", [
      { name: "first.png", data: firstBytes },
      { name: "second.jpg", data: secondBytes },
    ])
    const { attachments } = await assets.promoteAttachments(
      id,
      "ordered",
      drafts,
    )
    await assets.discardDraftAttachments(drafts)
    const images = attachments.map((attachment) => {
      if (attachment.mediaType === "application/pdf")
        throw new Error("Expected an image")
      return { type: "image" as const, ...attachment }
    })
    expect(images.map((image) => image.mediaType)).toEqual([
      "image/png",
      "image/jpeg",
    ])
    const firstImage = images[0]
    const secondImage = images[1]
    if (firstImage === undefined || secondImage === undefined)
      throw new Error("Missing ordered images")
    const item: ResponseItemEnvelope = {
      id: "ordered_user",
      turnId: "turn_ordered",
      createdAt: "2026-09-07T00:00:00Z",
      item: {
        role: "user",
        content: [
          firstImage,
          { type: "text", text: "between images" },
          secondImage,
        ],
      },
    }
    await store.appendItems(id, [
      { type: "response_item", item },
      {
        type: "compacted",
        turnId: "turn_ordered",
        summary: "checkpoint",
        replacement: [item],
      },
    ])
    await store.shutdownThread(id)
    const reopened = new JsonlThreadStore({ root })
    const restored = await reopened.resumeThread(id)
    expect(
      restored && ContextManager.fromStoredThread(restored).snapshot().history,
    ).toEqual([item])
    expect(
      await readFile(join(root, "rollouts", id, "rollout.jsonl"), "utf8"),
    ).not.toContain('"images":')
    const reopenedAssets = createStoreAssets(root, reopened)
    expect(await reopenedAssets.read(firstImage.file)).toEqual(firstBytes)
    expect(await reopenedAssets.read(secondImage.file)).toEqual(secondBytes)
    expect(requireStoredAssetSource(firstImage.file).rolloutId).toBe(id)
    expect(requireStoredAssetSource(secondImage.file).rolloutId).toBe(id)
    await reopened.shutdownThread(id)
  })

  it("creates child agents with their existing durable rollout lifecycle", async () => {
    const { root, store } = await createStore()
    const id = "thread_child_agent"
    await store.createThread(metadata(id, { parentThreadId: "thread_parent" }))
    expect(await store.listThreadIds()).toEqual([id])
    await expect(
      access(join(root, "rollouts", id, "rollout.jsonl")),
    ).resolves.toBeUndefined()
    await store.shutdownThread(id)
    expect((await store.readThread(id))?.rollout).toHaveLength(1)
  })

  it("keeps an ordinary root live without publishing idle history", async () => {
    const { root, store } = await createStore()
    const id = "thread_staged"
    const created = await store.createThread(metadata(id))
    expect(created.rollout.map((entry) => entry.item.type)).toEqual([
      "session_meta",
    ])
    await store.appendItems(id, [response("turn_seed", "seed")])
    await store.persistThread(id, "standard")
    await store.flushThread(id)
    expect((await store.readThread(id))?.rollout).toHaveLength(1)
    expect(await store.listThreadIds()).toEqual([])
    expect((await store.listThreads()).threads).toEqual([])
    expect(
      (await store.searchThreads({ searchTerm: "seed", limit: 10 })).matches,
    ).toEqual([])
    const otherStore = new JsonlThreadStore({ root })
    expect(await otherStore.readThread(id)).toBeUndefined()
    await expect(
      access(join(root, "threads", `${id}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(join(root, "rollouts", id))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await store.shutdownThread(id)
    expect(await store.readThread(id)).toBeUndefined()
    expect(await store.listThreadIds()).toEqual([])
  })

  it("publishes complete staged history at the first turn barrier", async () => {
    const { root, store } = await createStore()
    const id = "thread_first_turn"
    await store.createThread(metadata(id))
    await store.appendItems(id, [response("turn_seed", "seed")])
    await store.appendItems(id, [
      {
        type: "response_item",
        item: {
          id: "item_user",
          turnId: "turn_first",
          createdAt: new Date().toISOString(),
          item: { role: "user", content: [{ type: "text", text: "hello" }] },
        },
      },
      {
        type: "turn_started",
        turnId: "turn_first",
        inputItemId: "item_user",
        requestFingerprint: "fingerprint",
      },
    ])
    await store.persistThread(id, "turn_start")
    expect((await store.readThread(id))?.rollout.map(({ seq }) => seq)).toEqual(
      [0, 1, 2, 3],
    )
    expect(await store.listThreadIds()).toEqual([id])
    const reopened = new JsonlThreadStore({ root })
    expect(
      (await reopened.readThread(id))?.rollout.map(({ item }) => item.type),
    ).toEqual([
      "session_meta",
      "response_item",
      "response_item",
      "turn_started",
    ])
    await store.shutdownThread(id)
  })

  it("retains staged image assets through materialization and removes them on idle discard", async () => {
    const { root, store } = await createStore()
    const assets = createStoreAssets(root, store)
    const bytes = pngBytes()
    const imagePath = join(root, "source-image.png")
    await writeFile(imagePath, bytes)
    const id = "thread_images"
    await store.createThread(metadata(id))
    const [fromBytes] = await assets.importAttachmentBytes(id, "bytes", [
      { name: "image.png", data: bytes },
    ])
    const [fromPath] = await assets.importAttachmentPaths(id, "path", [
      imagePath,
    ])
    if (fromBytes === undefined || fromPath === undefined)
      throw new Error("Missing staged image attachment.")
    expect(await assets.read(fromBytes.file)).toEqual(bytes)
    expect(await assets.read(fromPath.file)).toEqual(bytes)
    expect(await store.listThreadIds()).toEqual([])
    const otherStore = new JsonlThreadStore({ root })
    await otherStore.initialize()
    expect(await assets.read(fromPath.file)).toEqual(bytes)
    await expect(
      otherStore.createThread(metadata(id, { parentThreadId: "parent" })),
    ).rejects.toThrow("active writer")
    expect(await assets.read(fromBytes.file)).toEqual(bytes)
    await store.persistThread(id, "turn_start")
    expect(await assets.read(fromBytes.file)).toEqual(bytes)
    expect(await assets.read(fromPath.file)).toEqual(bytes)
    await store.shutdownThread(id)
    const idle = "thread_idle_image"
    await store.createThread(metadata(idle))
    const [discarded] = await assets.importAttachmentBytes(idle, "draft", [
      { name: "image.png", data: bytes },
    ])
    if (discarded === undefined)
      throw new Error("Missing idle image attachment.")
    await store.discardThread(idle)
    await expect(assets.read(discarded.file)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(join(root, "rollouts", idle))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("retries failed first turn materialization with its staged history and assets", async () => {
    const { root, store } = await createStore()
    const assets = createStoreAssets(root, store)
    const id = "thread_retry_first_turn"
    await store.createThread(metadata(id))
    await store.appendItems(id, [response("turn_one", "original")])
    const bytes = pngBytes()
    const [attachment] = await assets.importAttachmentBytes(id, "draft", [
      { name: "image.png", data: bytes },
    ])
    if (attachment === undefined)
      throw new Error("Missing staged image attachment.")
    const probe = await open(join(root, "probe-first-turn"), "w+")
    const prototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>
    }
    const originalSync = prototype.sync
    let syncCount = 0
    prototype.sync = async function sync() {
      syncCount += 1
      if (syncCount === 4) {
        throw new Error("first turn sync failed")
      }
      await originalSync.call(this)
    }
    try {
      await expect(store.persistThread(id, "turn_start")).rejects.toThrow(
        "first turn sync failed",
      )
    } finally {
      prototype.sync = originalSync
      await probe.close()
    }
    expect(await store.listThreadIds()).toEqual([])
    expect((await store.readThread(id))?.rollout).toHaveLength(1)
    expect(await assets.read(attachment.file)).toEqual(bytes)
    await store.persistThread(id, "turn_start")
    expect((await store.readThread(id))?.rollout.map(({ seq }) => seq)).toEqual(
      [0, 1],
    )
    expect(await assets.read(attachment.file)).toEqual(bytes)
    await store.shutdownThread(id)
  })

  it("defers a live TurnStart sync until the normal persistence barrier", async () => {
    const { root, store } = await createStore()
    const id = "thread_deferred_turn_sync"
    await createPersistentThread(store, metadata(id))
    const probe = await open(join(root, "probe-turn-sync"), "w+")
    const prototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>
    }
    const originalSync = prototype.sync
    let syncs = 0
    prototype.sync = async function sync() {
      syncs += 1
      await originalSync.call(this)
    }
    try {
      await store.appendItems(id, [response("turn_one", "accepted")])
      const afterAppend = syncs
      await store.persistThread(id, "turn_start")
      expect(syncs).toBe(afterAppend)
      await store.persistThread(id, "standard")
      expect(syncs).toBeGreaterThan(afterAppend)
    } finally {
      prototype.sync = originalSync
      await probe.close()
      await store.shutdownThread(id)
    }
  })

  it("keeps a failed first turn private while preserving its original event sequence on retry", async () => {
    const { root, store } = await createStore()
    const id = "thread_private_first_turn"
    await store.createThread(metadata(id))
    // A first turn can have earlier staged records unrelated to its submission.
    await store.appendItems(id, [response("turn_earlier", "earlier")])
    await store.appendItems(id, [
      response("turn_first", "first input"),
      {
        type: "turn_context",
        context: {
          turnId: "turn_first",
          configuration: SessionConfiguration.create({
            selection: { provider: "faux", model: "scripted" },
            workspaceRoot: "/workspace",
            enabledTools: [],
            approvalPolicy: "always_approve",
            promptCacheKey: "turn_first",
          }).snapshot,
          selection: { provider: "faux", model: "scripted" },
        },
      },
      {
        type: "turn_started",
        turnId: "turn_first",
        inputItemId: "input_first",
      },
    ])
    const probe = await open(join(root, "probe-private-first-turn"), "w+")
    const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> }
    const originalSync = prototype.sync
    let count = 0
    prototype.sync = async function sync() {
      if (++count === 4) throw new Error("materialization failed")
      await originalSync.call(this)
    }
    try {
      await expect(store.persistThread(id, "turn_start")).rejects.toThrow(
        "materialization failed",
      )
    } finally {
      prototype.sync = originalSync
      await probe.close()
    }
    expect((await store.readThread(id))?.rollout.map(({ seq }) => seq)).toEqual(
      [0],
    )
    await store.persistThread(id, "turn_start")
    expect((await store.readThread(id))?.rollout.map(({ seq }) => seq)).toEqual(
      [0, 1, 2, 3, 4],
    )
    await store.shutdownThread(id)
    const reopened = new JsonlThreadStore({ root })
    expect((await reopened.readThread(id))?.rollout).toHaveLength(5)
  })

  it("shares staged shutdown cleanup across concurrent calls", async () => {
    const { root, store } = await createStore()
    const id = "thread_staged_shutdown"
    await store.createThread(metadata(id))
    const first = store.shutdownThread(id)
    const second = store.shutdownThread(id)
    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
    expect(await store.readThread(id)).toBeUndefined()
    await expect(
      access(join(root, "threads", `${id}.json`)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("keeps staged presentation in memory until the first turn and persists it across restart", async () => {
    const { root, store } = await createStore()
    const id = "thread_staged_sidebar"
    await store.createThread(metadata(id))
    await store.updateSessionSidebar({
      type: "session",
      sessionId: id,
      title: "Renamed draft",
      archived: true,
      sectionId: "pinned",
    })
    expect(await store.sessionPresentation(id)).toMatchObject({
      navigationId: id,
      title: "Renamed draft",
      archived: true,
      sectionId: "pinned",
    })
    expect((await store.readSessionSidebar()).entries[id]).toMatchObject({
      title: "Renamed draft",
      sectionId: "pinned",
    })
    await expect(
      access(join(root, "session-sidebar.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(
      (await store.listThreads({ view: "sessions", archived: true })).threads,
    ).toEqual([])
    expect(
      (
        await store.searchThreads({
          view: "sessions",
          archived: true,
          searchTerm: "Renamed draft",
          limit: 10,
        })
      ).matches,
    ).toEqual([])
    await store.persistThread(id, "turn_start")
    await store.shutdownThread(id)
    const reopened = new JsonlThreadStore({ root })
    expect(await reopened.sessionPresentation(id)).toMatchObject({
      navigationId: id,
      title: "Renamed draft",
      archived: true,
      sectionId: "pinned",
    })
    expect(
      (await reopened.listThreads({ view: "sessions", archived: true }))
        .threads[0],
    ).toMatchObject({ id, title: "Renamed draft", sectionId: "pinned" })
  })

  it("retries staged presentation after a failed first turn without publishing an orphan sidebar entry", async () => {
    const { root, store } = await createStore()
    const id = "thread_sidebar_retry"
    await store.createThread(metadata(id))
    await store.updateSessionSidebar({
      type: "session",
      sessionId: id,
      title: "Keep this title",
    })
    const probe = await open(join(root, "probe-sidebar-retry"), "w+")
    const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> }
    const originalSync = prototype.sync
    let count = 0
    prototype.sync = async function sync() {
      // Journal and metadata publish before the sidebar write.
      if (++count === 5) throw new Error("sidebar sync failed")
      await originalSync.call(this)
    }
    try {
      await expect(store.persistThread(id, "turn_start")).rejects.toThrow(
        "sidebar sync failed",
      )
    } finally {
      prototype.sync = originalSync
      await probe.close()
    }
    expect(await store.listThreadIds()).toEqual([])
    expect((await store.readSessionSidebar()).entries[id]?.title).toBe(
      "Keep this title",
    )
    const restartedBeforeRetry = new JsonlThreadStore({ root })
    expect(
      (await restartedBeforeRetry.readSessionSidebar()).entries[id],
    ).toBeUndefined()
    await store.persistThread(id, "turn_start")
    await store.shutdownThread(id)
    const restartedAfterRetry = new JsonlThreadStore({ root })
    expect((await restartedAfterRetry.sessionPresentation(id)).title).toBe(
      "Keep this title",
    )
  })

  it("durably acknowledges an idle agent message before its append resolves", async () => {
    const { root, store } = await createStore()
    const id = "thread_idle_agent_message"
    await store.createThread(metadata(id))
    const item: RolloutItem = {
      type: "agent_message",
      messageId: "agent_input",
      item: {
        id: "agent_input",
        turnId: "turn_agent",
        createdAt: new Date().toISOString(),
        item: { role: "user", content: [{ type: "text", text: "go" }] },
      },
    }
    expect(await store.appendItems(id, [item])).toMatchObject({
      throughSeq: 2,
      records: [{ seq: 1, item }],
    })
    const reopened = new JsonlThreadStore({ root })
    expect((await reopened.readThread(id))?.rollout[1]?.item).toEqual(item)
    await store.shutdownThread(id)
  })

  it("retries a failed staged agent message without duplicating its record", async () => {
    const { root, store } = await createStore()
    const id = "thread_retry_agent_message"
    await store.createThread(metadata(id))
    const item: RolloutItem = {
      type: "agent_message",
      messageId: "agent_retry",
      item: {
        id: "agent_retry",
        turnId: "turn_agent_retry",
        createdAt: new Date().toISOString(),
        item: { role: "user", content: [{ type: "text", text: "retry" }] },
      },
    }
    const probe = await open(join(root, "probe-agent-materialization"), "w+")
    const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> }
    const originalSync = prototype.sync
    let count = 0
    prototype.sync = async function sync() {
      if (++count === 4) throw new Error("agent sync failed")
      await originalSync.call(this)
    }
    try {
      await expect(store.appendItems(id, [item])).rejects.toThrow(
        "agent sync failed",
      )
    } finally {
      prototype.sync = originalSync
      await probe.close()
    }
    expect((await store.readThread(id))?.rollout.map(({ seq }) => seq)).toEqual(
      [0],
    )
    expect(await store.appendItems(id, [item])).toMatchObject({
      throughSeq: 2,
      records: [{ seq: 1, item }],
    })
    await store.shutdownThread(id)
    const reopened = new JsonlThreadStore({ root })
    expect(
      (await reopened.readThread(id))?.rollout.map(({ item }) => item.type),
    ).toEqual(["session_meta", "agent_message"])
  })

  it("preserves the session-owned Git identity across restart", async () => {
    const { root, store } = await createStore()
    const threadId = "thread_git_identity"
    await createPersistentThread(
      store,
      metadata(threadId, {
        gitInfo: {
          sha: "0123456789abcdef",
          branch: "feat/session-context",
          originUrl: "https://github.com/example/project.git",
        },
      }),
    )
    await store.shutdownThread(threadId)

    const reopened = new JsonlThreadStore({ root })
    expect((await reopened.resumeThread(threadId))?.metadata.gitInfo).toEqual({
      sha: "0123456789abcdef",
      branch: "feat/session-context",
      originUrl: "https://github.com/example/project.git",
    })
    await reopened.shutdownThread(threadId)
  })

  it("reopens structured Turn failures with nested diagnostic details", async () => {
    const { root, store } = await createStore()
    const threadId = "thread_structured_failure"
    const completed: RolloutItem = {
      type: "turn_completed",
      turnId: "turn_failed",
      outcome: "failed",
      error: {
        message: "The model response stream disconnected before completion.",
        code: "model.stream_disconnected",
        details: {
          provider: "grok",
          attempt: 2,
          transport: { wireApi: "openai_responses", causeCode: "EPIPE" },
        },
      },
    }
    await createPersistentThread(store, metadata(threadId))
    await store.appendItems(threadId, [completed])
    await store.shutdownThread(threadId)

    const reopened = new JsonlThreadStore({ root })
    const recovered = await reopened.resumeThread(threadId)

    expect(recovered?.rollout.at(-1)?.item).toEqual(completed)
    await reopened.shutdownThread(threadId)
  })

  it.each([
    0, 1, 2, 3, 4,
  ])("recovers a coherent context after %i checkpoint records reach disk", async (persistedCheckpointRecords) => {
    const { root, store } = await createStore()
    const threadId = "thread_checkpoint"
    await createPersistentThread(store, metadata(threadId))
    const original = response("turn_old", "old history")
    const replacement = response("turn_compact", "checkpoint")
    await store.appendItems(threadId, [
      original,
      {
        type: "model_context",
        settings: { provider: "codex", model: "old", compactionHash: "one" },
      },
      {
        type: "world_state",
        turnId: "turn_old",
        full: true,
        state: { environment: { cwd: "/old" } },
      },
      { type: "token_count", turnId: "turn_old", activeContextTokens: 9_999 },
    ])
    const prefixLength = (await store.readThread(threadId))?.rollout.length
    if (prefixLength === undefined) throw new Error("missing initial rollout")
    await store.appendItems(threadId, [
      {
        type: "compacted",
        turnId: "turn_compact",
        replacement: [replacement.item],
        summary: "checkpoint",
      },
      {
        type: "world_state",
        turnId: "turn_compact",
        full: true,
        state: { environment: { cwd: "/new" } },
      },
      { type: "token_count", turnId: "turn_compact", activeContextTokens: 30 },
      {
        type: "item_completed",
        turnId: "turn_compact",
        item: {
          type: "context_compaction",
          itemId: "checkpoint_item",
          status: "completed",
        },
      },
    ])
    await store.shutdownThread(threadId)
    const path = join(root, "rollouts", threadId, "rollout.jsonl")
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n")
    const count = prefixLength + persistedCheckpointRecords
    // Crash image: complete records followed by an interrupted next write.
    await writeFile(
      path,
      `${lines.slice(0, count).join("\n")}\n${lines[count]?.slice(0, 12) ?? ""}`,
    )
    const recoveredStore = new JsonlThreadStore({ root })
    const recovered = await recoveredStore.resumeThread(threadId)
    if (recovered === undefined) throw new Error("missing recovered rollout")
    const context = ContextManager.fromStoredThread(recovered).snapshot()
    expect(context.history).toEqual([
      persistedCheckpointRecords === 0 ? original.item : replacement.item,
    ])
    expect(context.worldStateBaseline).toEqual(
      persistedCheckpointRecords === 0
        ? { environment: { cwd: "/old" } }
        : persistedCheckpointRecords === 1
          ? undefined
          : { environment: { cwd: "/new" } },
    )
    expect(context.activeContextTokens).toBe(
      persistedCheckpointRecords === 0
        ? 9_999
        : persistedCheckpointRecords < 3
          ? undefined
          : 30,
    )
    expect(context.previousModel?.compactionHash).toBe("one")
    expect(
      recovered.rollout.some(({ item }) => item.type === "item_completed"),
    ).toBe(persistedCheckpointRecords === 4)
    await recoveredStore.shutdownThread(threadId)
  })
  it("restores latest context usage and invalidates it when history is replaced", async () => {
    const { store } = await createStore()
    await createPersistentThread(store, metadata("thread_tokens"))
    await store.appendItems("thread_tokens", [
      { type: "token_count", turnId: "turn_one", activeContextTokens: 500 },
      { type: "token_count", turnId: "turn_one", activeContextTokens: 900 },
    ])
    await store.shutdownThread("thread_tokens")
    const before = await store.resumeThread("thread_tokens")
    if (before === undefined) throw new Error("missing stored thread")
    expect(
      ContextManager.fromStoredThread(before).snapshot().activeContextTokens,
    ).toBe(900)
    await store.appendItems("thread_tokens", [
      {
        type: "compacted",
        turnId: "turn_two",
        replacement: [],
        summary: "checkpoint",
      },
    ])
    await store.shutdownThread("thread_tokens")
    const replaced = await store.resumeThread("thread_tokens")
    if (replaced === undefined) throw new Error("missing stored thread")
    expect(
      ContextManager.fromStoredThread(replaced).snapshot().activeContextTokens,
    ).toBeUndefined()
    await store.appendItems("thread_tokens", [
      { type: "token_count", turnId: "turn_two", activeContextTokens: 0 },
    ])
    await store.shutdownThread("thread_tokens")
    const after = await store.readThread("thread_tokens")
    if (after === undefined) throw new Error("missing stored thread")
    expect(
      ContextManager.fromStoredThread(after).snapshot().activeContextTokens,
    ).toBe(0)
  })

  it("persists the sampled window capacity on token_count records", async () => {
    const { store } = await createStore()
    await createPersistentThread(store, metadata("thread_capacity"))
    await store.appendItems("thread_capacity", [
      {
        type: "token_count",
        turnId: "turn_one",
        activeContextTokens: 900,
        provider: "kimi",
        model: "k3",
        capacityTokens: 258_000,
      },
    ])
    const stored = await store.readThread("thread_capacity")
    if (stored === undefined) throw new Error("missing stored thread")
    expect(stored.rollout.at(-1)?.item).toEqual({
      type: "token_count",
      turnId: "turn_one",
      activeContextTokens: 900,
      provider: "kimi",
      model: "k3",
      capacityTokens: 258_000,
    })
    await store.shutdownThread("thread_capacity")
  })

  it("restores and replaces the auto-compaction prefill estimate", async () => {
    const { store } = await createStore()
    await createPersistentThread(store, metadata("thread_prefill"))
    await store.appendItems("thread_prefill", [
      {
        type: "token_count",
        turnId: "turn_one",
        activeContextTokens: 900,
        autoCompactPrefillTokens: 800,
        autoCompactPrefillEstimated: true,
      },
      {
        type: "token_count",
        turnId: "turn_one",
        activeContextTokens: 950,
        autoCompactPrefillTokens: 820,
      },
    ])
    await store.shutdownThread("thread_prefill")
    const stored = await store.resumeThread("thread_prefill")
    if (stored === undefined) throw new Error("missing stored prefill")
    expect(ContextManager.fromStoredThread(stored).snapshot()).toMatchObject({
      activeContextTokens: 950,
      autoCompactPrefillTokens: 820,
    })
    expect(
      ContextManager.fromStoredThread(stored).snapshot()
        .autoCompactPrefillEstimated,
    ).toBeUndefined()
    await store.shutdownThread("thread_prefill")
  })

  it("persists ordered rollout items and resumes a single live writer", async () => {
    const { store } = await createStore()
    await createPersistentThread(store, metadata("thread_root"))
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

  it("round-trips full world-state markers and completed host items", async () => {
    const { store } = await createStore()
    await createPersistentThread(store, metadata("thread_current_rollout"))
    await store.appendItems("thread_current_rollout", [
      {
        type: "world_state",
        turnId: "turn_one",
        full: true,
        state: { environment: { cwd: "/workspace" } },
      },
      {
        type: "item_completed",
        turnId: "turn_one",
        item: {
          type: "agent_message",
          itemId: "message_one",
          content: [{ type: "text", text: "done" }],
        },
      },
    ])
    await store.shutdownThread("thread_current_rollout")

    const resumed = await store.resumeThread("thread_current_rollout")
    expect(resumed?.rollout.slice(-2).map((entry) => entry.item)).toEqual([
      {
        type: "world_state",
        turnId: "turn_one",
        full: true,
        state: { environment: { cwd: "/workspace" } },
      },
      {
        type: "item_completed",
        turnId: "turn_one",
        item: {
          type: "agent_message",
          itemId: "message_one",
          content: [{ type: "text", text: "done" }],
        },
      },
    ])
    await store.shutdownThread("thread_current_rollout")
  })

  it("rejects a second writer opened by another store instance", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_shared"))
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
    await createPersistentThread(store, metadata("thread_source"))
    await store.appendItems("thread_source", [
      { type: "turn_started", turnId: "turn_one", inputItemId: "input_one" },
      response("turn_one", "one"),
      terminal("turn_one"),
      { type: "turn_started", turnId: "turn_two", inputItemId: "input_two" },
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
      await readFile(
        join(root, "rollouts", "thread_child", "rollout.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
    expect(childLines).toHaveLength(1)
    expect(fork.thread.metadata.historyBase).toEqual({
      rolloutId: "thread_source",
      endSeqExclusive: 4,
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
    await createPersistentThread(store, metadata("thread_empty_source"))
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
    await expect(createPersistentThread(store, forged)).rejects.toThrow(
      "cannot provide physical rollout or inherited history",
    )
    await expect(
      access(join(root, "threads", "thread_forged.json")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("counts retained physical usage once after deleting the original conversation and reopening the store", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("usage_source"))
    await store.appendItems("usage_source", [
      {
        type: "turn_completed",
        turnId: "source_turn",
        outcome: "completed",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    ])
    const prepared = await store.prepareFork({
      sourceThreadId: "usage_source",
      boundary: { type: "latest" },
    })
    await store.createFork({
      prepared,
      target: metadata("usage_child", { parentThreadId: "usage_source" }),
    })
    await store.appendItems("usage_child", [
      {
        type: "turn_completed",
        turnId: "child_turn",
        outcome: "completed",
        usage: { inputTokens: 40, outputTokens: 10 },
      },
    ])
    await store.flushThread("usage_child")
    const before = await store.readUsageSummary()
    expect(before.totals).toMatchObject({
      inputTokens: 140,
      outputTokens: 30,
      turns: 2,
    })
    await store.shutdownThread("usage_source")
    await store.deleteThread("usage_source")
    const after = await store.readUsageSummary()
    expect(after.totals).toEqual(before.totals)
    expect(after.days).toEqual(before.days)
    expect(after.threads.map((row) => [row.threadId, row.totalTokens])).toEqual(
      [["usage_child", 50]],
    )
    await store.shutdownThread("usage_child")
    // A stale derived-cache version must rebuild from the same retained records.
    const cache = new DatabaseSync(join(root, "thread-usage.sqlite"))
    cache.exec("PRAGMA user_version = 2")
    cache.close()
    const reopened = new JsonlThreadStore({ root })
    expect((await reopened.readUsageSummary()).totals).toEqual(before.totals)
    expect(
      (await reopened.readUsageSummary()).unavailableThreads,
    ).toBeUndefined()
  })

  it.each([
    3, 4,
  ])("reads recorded usage from known historical configuration v%s without allowing execution replay", async (schemaVersion) => {
    const { root, store } = await createStore()
    const id = `legacy_usage_${schemaVersion}`
    await createPersistentThread(store, metadata(id))
    await store.appendItems(id, [
      {
        type: "turn_context",
        context: {
          turnId: "legacy_turn",
          selection: { provider: "codex", model: "historical" },
          configuration: SessionConfiguration.create({
            selection: { provider: "faux", model: "scripted" },
            workspaceRoot: root,
            enabledTools: [],
            approvalPolicy: "always_approve",
            promptCacheKey: id,
          }).snapshot,
        },
      },
      {
        type: "turn_completed",
        turnId: "legacy_turn",
        outcome: "completed",
        usage: {
          inputTokens: 1000000,
          outputTokens: 1000,
          cacheReadInputTokens: 900000,
        },
      },
    ])
    await store.shutdownThread(id)
    const path = join(root, "rollouts", id, "rollout.jsonl")
    const rows = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    for (const row of rows)
      if (row.item.type === "turn_context") {
        row.item.context.configuration.schemaVersion = schemaVersion
        delete row.item.context.configuration.modelAutoCompactTokenLimitScope
        if (schemaVersion === 3)
          row.item.context.configuration.approvalPolicy = "never"
      }
    const historicalBytes = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    await writeFile(path, historicalBytes)
    await expect(store.readThread(id)).rejects.toThrow("invalid item")
    const usage = await store.readUsageSummary()
    expect(usage.unavailableThreads).toBeUndefined()
    expect(usage.totals).toMatchObject({
      inputTokens: 1000000,
      outputTokens: 1000,
      cacheReadInputTokens: 900000,
      turns: 1,
    })
    expect(
      usage.models.map((row) => [row.provider, row.model, row.inputTokens]),
    ).toEqual([["codex", "historical", 1000000]])
    expect(await readFile(path, "utf8")).toBe(historicalBytes)
    // Unknown schema cannot be silently guessed from familiar token fields.
    for (const row of rows)
      if (row.item.type === "turn_context")
        row.item.context.configuration.schemaVersion = 99
    await writeFile(
      path,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    )
    const unknown = await store.readUsageSummary()
    expect(unknown.unavailableThreads).toBe(1)
    expect(unknown.totals.turns).toBe(0)
  })

  it("reports unreadable usage histories without estimating missing tokens and clears the warning after repair", async () => {
    const { root, store } = await createStore()
    for (const [id, tokens] of [
      ["usage_healthy", 50],
      ["usage_unreadable", 500],
    ] as const) {
      await createPersistentThread(store, metadata(id))
      await store.appendItems(id, [
        {
          type: "turn_completed",
          turnId: "turn",
          outcome: "completed",
          usage: { inputTokens: tokens, outputTokens: 0 },
        },
      ])
      await store.shutdownThread(id)
    }
    expect((await store.readUsageSummary()).totals.inputTokens).toBe(550)
    const path = join(root, "threads", "usage_unreadable.json")
    const valid = await readFile(path, "utf8")
    await writeFile(path, "{broken")
    const partial = await store.readUsageSummary()
    expect(partial.totals.inputTokens).toBe(50)
    expect(partial.unavailableThreads).toBe(1)
    expect((await store.readUsageSummary()).unavailableThreads).toBe(1)
    await writeFile(path, valid)
    const repaired = await store.readUsageSummary()
    expect(repaired.totals.inputTokens).toBe(550)
    expect(repaired.unavailableThreads).toBeUndefined()
  })

  it("retains inherited media after source deletion and removes it only after the last referencing thread", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_source"))
    const assets = createStoreAssets(root, store)
    const saved = await assets.saveToolFile(
      "thread_source",
      "read_image",
      "screen.png",
      pngBytes(),
    )
    const media: RolloutItem = {
      type: "response_item",
      item: {
        id: "tool_image",
        turnId: "turn_one",
        createdAt: "2026-09-07T00:00:00Z",
        item: {
          role: "tool",
          toolCallId: "read_image",
          content: [
            { type: "text", text: "saved image" },
            {
              type: "image",
              mediaType: "image/png",
              file: saved.reference,
              sizeBytes: pngBytes().byteLength,
            },
          ],
        },
      },
    }
    await store.appendItems("thread_source", [
      response("turn_one", "one"),
      media,
      terminal("turn_one"),
    ])
    for (const child of ["thread_child", "thread_sibling"]) {
      const prepared = await store.prepareFork({
        sourceThreadId: "thread_source",
        boundary: { type: "latest" },
      })
      await store.createFork({
        prepared,
        target: metadata(child, { parentThreadId: "thread_source" }),
      })
      await store.shutdownThread(child)
    }
    await store.shutdownThread("thread_source")
    await store.deleteThread("thread_source")
    expect(await store.readThread("thread_source")).toBeUndefined()

    const reopened = new JsonlThreadStore({ root })
    const surviving = await reopened.readThread("thread_child")
    expect(surviving?.rollout.map((entry) => entry.item)).toContainEqual(media)
    expect(
      surviving &&
        ContextManager.fromStoredThread(surviving)
          .snapshot()
          .history.map((entry) => entry.item),
    ).toContainEqual(media.item.item)
    expect(
      await createStoreAssets(root, reopened).read(saved.reference),
    ).toEqual(pngBytes())
    await reopened.deleteThread("thread_child")
    expect(await assets.read(saved.reference)).toEqual(pngBytes())
    expect(
      (await reopened.readThread("thread_sibling"))?.rollout.map(
        (entry) => entry.item,
      ),
    ).toContainEqual(media)
    await reopened.deleteThread("thread_sibling")
    await expect(
      access(join(root, "rollouts", "thread_source")),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(assets.read(saved.reference)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("serializes asset creation with deletion and cannot revive a bundle", async () => {
    const { root, store } = await createStore()
    const rolloutId = "thread_asset_race"
    await createPersistentThread(store, metadata(rolloutId))
    await store.shutdownThread(rolloutId)
    const entered = deferred<void>()
    const release = deferred<void>()
    const assets = createRolloutAssets(root, {
      withMutationLease: (candidate, mutate) =>
        store.withRolloutAssetMutation(candidate, async () => {
          entered.resolve()
          await release.promise
          return mutate()
        }),
    })

    const preparing = assets.saveToolFile(
      rolloutId,
      "call_race",
      "stdout.log",
      new Uint8Array(),
    )
    await entered.promise
    const deleting = store.deleteThread(rolloutId)
    release.resolve()
    const prepared = await preparing
    await deleting

    await expect(assets.read(prepared.reference)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(
      assets.saveToolFile(
        rolloutId,
        "call_after_delete",
        "stdout.log",
        new Uint8Array(),
      ),
    ).rejects.toMatchObject({ code: YakitoriErrorCode.NotFound })
    await expect(
      access(join(root, "rollouts", rolloutId)),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("holds and releases a source deletion reservation around fork preparation", async () => {
    const { store } = await createStore()
    await createPersistentThread(store, metadata("thread_source"))
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
    await createPersistentThread(store, metadata("thread_source"))
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
    await createPersistentThread(store, metadata("thread_recover"))
    await store.appendItems("thread_recover", [response("turn_one", "one")])
    await store.shutdownThread("thread_recover")
    const rolloutPath = join(
      root,
      "rollouts",
      "thread_recover",
      "rollout.jsonl",
    )
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

  it("preserves a valid trailing record when newline repair cannot sync", async () => {
    const { root, store } = await createStore()
    const id = "thread_tail_sync_failure"
    await createPersistentThread(store, metadata(id))
    await store.shutdownThread(id)
    const path = join(root, "rollouts", id, "rollout.jsonl")
    const entry = {
      threadId: id,
      rolloutId: id,
      seq: 1,
      createdAt: new Date().toISOString(),
      item: response("turn_recovered", "complete recoverable input"),
    }
    await appendFile(path, JSON.stringify(entry))
    const probe = await open(join(root, "probe-tail-sync"), "w+")
    const prototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>
    }
    const originalSync = prototype.sync
    let failSync = true
    prototype.sync = async function sync() {
      if (failSync) {
        failSync = false
        throw new Error("newline repair sync failed")
      }
      await originalSync.call(this)
    }
    try {
      await expect(store.resumeThread(id)).rejects.toThrow(
        "newline repair sync failed",
      )
    } finally {
      prototype.sync = originalSync
      await probe.close()
    }
    expect(
      (await readFile(path, "utf8")).endsWith(`${JSON.stringify(entry)}\n`),
    ).toBe(true)
    const restored = await store.resumeThread(id)
    expect(
      restored?.rollout.flatMap(({ item }) =>
        item.type === "response_item" ? [item.item.turnId] : [],
      ),
    ).toEqual(["turn_recovered"])
    await store.shutdownThread(id)
    expect(
      (await store.readThread(id))?.rollout.filter(
        ({ item }) => item.type === "response_item",
      ),
    ).toHaveLength(1)
  })

  it("resolves multi-generation lineage using physical history positions", async () => {
    const { store } = await createStore()
    await createPersistentThread(store, metadata("thread_root"))
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
    await createPersistentThread(store, metadata("thread_shutdown"))

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
    await createPersistentThread(store, metadata("thread_partial_retry"))
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

  it("keeps the committed prefix searchable after a later record fails and is retried", async () => {
    const { root, store } = await createStore()
    const id = "thread_search_drain_retry"
    await createPersistentThread(store, metadata(id))
    const probe = await open(join(root, "probe-search-drain"), "w+")
    const prototype = Object.getPrototypeOf(probe) as {
      write(
        buffer: Buffer,
        offset: number,
        length: number,
      ): Promise<{ readonly bytesWritten: number; readonly buffer: Buffer }>
    }
    const originalWrite = prototype.write
    let attempts = 0
    prototype.write = async function write(buffer, offset, length) {
      attempts += 1
      if (attempts === 2 || attempts === 3) {
        throw new Error("later record write failed")
      }
      return originalWrite.call(this, buffer, offset, length)
    }
    try {
      await expect(
        store.appendItems(id, [
          response("turn_prefix", "committed-prefix-needle"),
          response("turn_suffix", "retried-suffix-needle"),
        ]),
      ).rejects.toThrow("later record write failed")
    } finally {
      prototype.write = originalWrite
      await probe.close()
    }
    await store.flushThread(id)
    expect(
      (await store.readThread(id))?.rollout.flatMap(({ item }) =>
        item.type === "response_item" ? [item.item.turnId] : [],
      ),
    ).toEqual(["turn_prefix", "turn_suffix"])
    for (const restart of [false, true]) {
      if (restart) await store.shutdownThread(id)
      const reader = restart ? new JsonlThreadStore({ root }) : store
      await reader.readThread(id)
      for (const searchTerm of [
        "committed-prefix-needle",
        "retried-suffix-needle",
      ]) {
        await expect(
          reader.searchThreads({ searchTerm, limit: 10 }),
        ).resolves.toMatchObject({
          matches: [{ summary: { id } }],
        })
        await expect(
          reader.searchThreadOccurrences({
            threadId: id,
            searchTerm,
            limit: 10,
          }),
        ).resolves.toMatchObject({
          occurrences: [
            {
              turnId: searchTerm.startsWith("committed")
                ? "turn_prefix"
                : "turn_suffix",
            },
          ],
        })
      }
    }
  })

  it("does not duplicate a record when write completion is reported as failure", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_ack_lost"))
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
    "partial",
    "complete",
  ] as const)("reconciles an uncertain %s retry before a later flush", async (writeKind) => {
    const { root, store } = await createStore()
    const id = "thread_second_write_failure"
    await createPersistentThread(store, metadata(id))
    const probe = await open(join(root, "probe-second-write"), "w+")
    const prototype = Object.getPrototypeOf(probe) as {
      write(
        buffer: Buffer,
        offset: number,
        length: number,
      ): Promise<{ readonly bytesWritten: number; readonly buffer: Buffer }>
    }
    const originalWrite = prototype.write
    let attempts = 0
    prototype.write = async function write(buffer, offset, length) {
      attempts += 1
      if (attempts === 1) throw new Error("first write failed")
      if (attempts === 2) {
        await originalWrite.call(
          this,
          buffer,
          offset,
          writeKind === "partial" ? Math.min(length, 17) : length,
        )
        throw new Error("retry write acknowledgement lost")
      }
      return originalWrite.call(this, buffer, offset, length)
    }
    try {
      await expect(
        store.appendItems(id, [response("turn_retried", "only once")]),
      ).rejects.toThrow("retry write acknowledgement lost")
    } finally {
      prototype.write = originalWrite
      await probe.close()
    }
    try {
      await store.flushThread(id)
      await store.shutdownThread(id)
      const reopened = new JsonlThreadStore({ root })
      expect(
        (await reopened.readThread(id))?.rollout.flatMap(({ item }) =>
          item.type === "response_item" ? [item.item.turnId] : [],
        ),
      ).toEqual(["turn_retried"])
    } finally {
      await store.discardThread(id)
    }
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
      createPersistentThread(store, metadata("thread_create_retry")),
    ).resolves.toBeDefined()
    await store.shutdownThread("thread_create_retry")
  })

  it("enforces writer and reservation ownership across processes", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_process"))

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
    await createPersistentThread(store, metadata("thread_valid_tail"))
    await store.appendItems("thread_valid_tail", [response("turn_one", "one")])
    await store.shutdownThread("thread_valid_tail")
    const rolloutPath = join(
      root,
      "rollouts",
      "thread_valid_tail",
      "rollout.jsonl",
    )
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
    await createPersistentThread(store, metadata("thread_corrupt"))
    await store.appendItems("thread_corrupt", [response("turn_one", "one")])
    await store.shutdownThread("thread_corrupt")
    const rolloutPath = join(
      root,
      "rollouts",
      "thread_corrupt",
      "rollout.jsonl",
    )
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
    await createPersistentThread(store, metadata("thread_malformed_message"))
    await store.shutdownThread("thread_malformed_message")
    await appendFile(
      join(root, "rollouts", "thread_malformed_message", "rollout.jsonl"),
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

  it("preserves request start on reload and rejects malformed request timestamps", async () => {
    const { root, store } = await createStore()
    const id = "thread_request_clock"
    await createPersistentThread(store, metadata(id))
    await store.appendItems(id, [
      {
        type: "turn_completed",
        turnId: "turn_request",
        outcome: "completed",
        lastRequestStartedAt: "2026-09-20T10:00:00.000Z",
      },
    ])
    await store.shutdownThread(id)
    const rolloutPath = join(root, "rollouts", id, "rollout.jsonl")
    const restarted = new JsonlThreadStore({ root })
    expect(
      (await restarted.readThread(id))?.rollout.at(-1)?.item,
    ).toMatchObject({
      lastRequestStartedAt: "2026-09-20T10:00:00.000Z",
    })

    const lines = (await readFile(rolloutPath, "utf8")).trim().split("\n")
    const last = JSON.parse(lines.at(-1) ?? "null") as {
      item: { lastRequestStartedAt: unknown }
    }
    last.item.lastRequestStartedAt = "2026-09-20T10:00:00Z"
    lines[lines.length - 1] = JSON.stringify(last)
    await writeFile(rolloutPath, `${lines.join("\n")}\n`)
    await expect(new JsonlThreadStore({ root }).readThread(id)).rejects.toThrow(
      "contains an invalid item",
    )
  })

  it("uses original BeforeTurn and newest ThroughTurn occurrences", async () => {
    const { store } = await createStore()
    await createPersistentThread(store, metadata("thread_boundary"))
    await store.appendItems("thread_boundary", [
      {
        type: "turn_started",
        turnId: "turn_repeat",
        inputItemId: "input_first",
      },
      response("turn_repeat", "first"),
      terminal("turn_repeat"),
      {
        type: "turn_started",
        turnId: "turn_repeat",
        inputItemId: "input_second",
      },
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
    expect(through.historyPosition?.endSeqExclusive).toBe(7)
    await store.releasePreparedFork(through)
    await store.shutdownThread("thread_boundary")
  })

  it("keeps healthy Threads listable when an index points to no rollout", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_healthy"))
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

  it("lists the current durable summary after metadata and rollout changes from another store", async () => {
    const { root, store } = await createStore()
    const threadId = "thread_list_current"
    await createPersistentThread(store, metadata(threadId))
    await store.shutdownThread(threadId)

    const reader = new JsonlThreadStore({ root })
    expect((await reader.listThreads()).threads).toMatchObject([
      { id: threadId, seq: 0 },
    ])

    const writer = new JsonlThreadStore({ root })
    await writer.resumeThread(threadId)
    await writer.appendItems(threadId, [
      response("turn_external", "persisted elsewhere"),
    ])
    expect((await writer.listThreads()).threads).toMatchObject([
      { id: threadId, seq: 1 },
    ])
    await writer.shutdownThread(threadId)

    const metadataPath = join(root, "threads", `${threadId}.json`)
    const saved = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
      string,
      unknown
    >
    await writeFile(
      metadataPath,
      `${JSON.stringify({ ...saved, title: "Changed outside this store" })}\n`,
    )

    expect((await reader.listThreads()).threads).toMatchObject([
      { id: threadId, title: "Changed outside this store", seq: 1 },
    ])
  })

  it("starts with a damaged index without deleting healthy rollout state", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_healthy_restart"))
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
    await createPersistentThread(store, metadata("thread_traversal"))
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

  it("keeps healthy Threads searchable and reports unavailable histories until repaired", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_healthy_rollout"))
    await createPersistentThread(store, metadata("thread_broken_rollout"))
    await store.appendItems("thread_healthy_rollout", [
      response("turn_healthy", "healthy searchable message"),
      terminal("turn_healthy"),
    ])
    await store.shutdownThread("thread_healthy_rollout")
    await store.shutdownThread("thread_broken_rollout")
    const brokenPath = join(
      root,
      "rollouts",
      "thread_broken_rollout",
      "rollout.jsonl",
    )
    const original = await readFile(brokenPath, "utf8")
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
    await expect(
      restarted.searchThreads({ searchTerm: "healthy", limit: 10 }),
    ).resolves.toMatchObject({
      matches: [{ summary: { id: "thread_healthy_rollout" } }],
      unavailableThreadCount: 1,
    })
    await expect(
      restarted.searchThreadOccurrences({
        threadId: "thread_healthy_rollout",
        searchTerm: "searchable",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      occurrences: [
        { turnId: "turn_healthy", snippet: "healthy searchable message" },
      ],
    })
    await expect(
      restarted.searchThreadOccurrences({
        threadId: "thread_broken_rollout",
        searchTerm: "healthy",
        limit: 10,
      }),
    ).rejects.toThrow("Cannot search unreadable Thread thread_broken_rollout")

    await writeFile(brokenPath, original)
    const repaired = await restarted.searchThreads({
      searchTerm: "healthy",
      limit: 10,
    })
    expect(repaired.matches.map(({ summary }) => summary.id)).toEqual([
      "thread_healthy_rollout",
    ])
    expect(repaired.unavailableThreadCount).toBeUndefined()
  })

  it.each([
    { outcome: "completed", completion: { reason: "unknown" } },
    {
      outcome: "completed",
      completion: { answerItemIds: ["duplicate", "duplicate"] },
    },
    { outcome: "failed", completion: { reason: "truncated" } },
  ])("rejects invalid durable completion metadata $outcome $completion", async (invalid) => {
    const { root, store } = await createStore()
    const threadId = "thread_invalid_completion"
    await createPersistentThread(store, metadata(threadId))
    await store.appendItems(threadId, [terminal("turn_invalid")])
    await store.shutdownThread(threadId)
    const path = join(root, "rollouts", threadId, "rollout.jsonl")
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n")
    const terminalRecord = JSON.parse(lines.pop() ?? "null") as {
      item: Record<string, unknown>
    }
    terminalRecord.item = { ...terminalRecord.item, ...invalid }
    lines.push(JSON.stringify(terminalRecord))
    await writeFile(path, `${lines.join("\n")}\n`)
    const reader = new JsonlThreadStore({ root })
    await expect(reader.readThread(threadId)).rejects.toThrow(
      "contains an invalid item",
    )
  })

  it("preserves completion metadata and indexes a continued answer across append and restart", async () => {
    const { root, store } = await createStore()
    const threadId = "thread_continued_answer"
    await createPersistentThread(store, metadata(threadId))
    const assistant = (id: string, text: string): RolloutItem => ({
      type: "response_item",
      item: {
        id,
        turnId: "turn_chain",
        createdAt: "2026-10-02T00:00:00.000Z",
        item: { role: "assistant", content: [{ type: "text", text }] },
      },
    })
    await store.appendItems(threadId, [assistant("piece_one", "**Con")])
    await store.appendItems(threadId, [
      assistant("piece_two", "tinuation**"),
      {
        type: "turn_completed",
        turnId: "turn_chain",
        outcome: "completed",
        completion: {
          reason: "truncated",
          answerItemIds: ["piece_one", "piece_two"],
        },
      },
    ])
    const expected = {
      occurrences: [
        {
          turnId: "turn_chain",
          itemId: "piece_two",
          snippet: "Continuation",
          snippetMatchRange: { start: 0, end: 12 },
        },
      ],
    }
    await expect(
      store.searchThreadOccurrences({
        threadId,
        searchTerm: "Continuation",
        limit: 10,
      }),
    ).resolves.toMatchObject(expected)
    await store.shutdownThread(threadId)
    const restarted = new JsonlThreadStore({ root })
    expect(
      (await restarted.readThread(threadId))?.rollout.at(-1)?.item,
    ).toMatchObject({
      outcome: "completed",
      completion: {
        reason: "truncated",
        answerItemIds: ["piece_one", "piece_two"],
      },
    })
    await expect(
      restarted.searchThreadOccurrences({
        threadId,
        searchTerm: "Continuation",
        limit: 10,
      }),
    ).resolves.toMatchObject(expected)
  })

  it("persists and incrementally pages the visible-history search projection", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_search_projection"))
    await store.appendItems("thread_search_projection", [
      response("turn_search_one", "needle needle needle"),
      terminal("turn_search_one"),
    ])

    const first = await store.searchThreadOccurrences({
      threadId: "thread_search_projection",
      searchTerm: "needle",
      limit: 2,
    })
    expect(first?.occurrences).toHaveLength(2)
    expect(first?.nextCursor).toBeDefined()

    await store.appendItems("thread_search_projection", [
      response("turn_search_two", "later needle"),
      terminal("turn_search_two"),
      {
        type: "response_item",
        item: {
          id: "message_turn_cleared_text",
          turnId: "turn_cleared",
          createdAt: new Date().toISOString(),
          item: {
            role: "assistant",
            content: [{ type: "text", text: "discarded answer" }],
          },
        },
      },
      {
        type: "response_item",
        item: {
          id: "message_turn_cleared_reasoning",
          turnId: "turn_cleared",
          createdAt: new Date().toISOString(),
          item: {
            role: "assistant",
            content: [{ type: "reasoning", text: "done" }],
          },
        },
      },
      terminal("turn_cleared"),
    ])
    const second = await store.searchThreadOccurrences({
      threadId: "thread_search_projection",
      searchTerm: "needle",
      limit: 2,
      ...(first?.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    })
    expect(second?.occurrences.map(({ turnId }) => turnId)).toEqual([
      "turn_search_one",
      "turn_search_two",
    ])
    expect(second?.nextCursor).toBeUndefined()
    await expect(
      store.searchThreads({ searchTerm: "discarded answer", limit: 1 }),
    ).resolves.toEqual({ matches: [] })
    await store.shutdownThread("thread_search_projection")

    await expect(
      access(join(root, "thread-search.sqlite")),
    ).resolves.toBeUndefined()
    const restarted = new JsonlThreadStore({ root })
    await expect(
      restarted.searchThreads({ searchTerm: "later needle", limit: 1 }),
    ).resolves.toMatchObject({
      matches: [{ summary: { id: "thread_search_projection" } }],
    })
  })

  it("waits for storage coordination during startup instead of rejecting readiness", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_coordinated"))
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
    await createPersistentThread(store, metadata("thread_source"))
    await createPersistentThread(store, metadata("thread_target"))
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

  it.each([
    "invalid JSON",
    "invalid schema",
    "sequence gap",
  ])("reads and resumes a fork without parsing an ancestor's later %s", async (corruption) => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_source"))
    await store.appendItems("thread_source", [
      response("turn_one", "你好 prefix"),
    ])
    const prepared = await store.prepareFork({
      sourceThreadId: "thread_source",
      boundary: { type: "latest" },
    })
    await store.createFork({
      prepared,
      target: metadata("thread_child", { parentThreadId: "thread_source" }),
    })
    await store.shutdownThread("thread_child")
    await store.shutdownThread("thread_source")
    const sourcePath = join(root, "rollouts", "thread_source", "rollout.jsonl")
    const prefix = await readFile(sourcePath, "utf8")
    const previous = JSON.parse(prefix.trim().split("\n").at(-1) ?? "") as {
      seq: number
      item: unknown
    }
    const suffix =
      corruption === "invalid JSON"
        ? "not json"
        : JSON.stringify({
            ...previous,
            seq: corruption === "sequence gap" ? 99 : previous.seq + 1,
            item:
              corruption === "invalid schema"
                ? { type: "unknown_record" }
                : response("turn_later", "outside fork"),
          })
    await appendFile(sourcePath, `${suffix}\n`)
    await expect(store.readThread("thread_source")).rejects.toThrow()
    const reader = new JsonlThreadStore({ root })
    for (const stored of [
      await reader.readThread("thread_child"),
      await reader.resumeThread("thread_child"),
    ]) {
      expect(
        stored?.rollout.flatMap(({ item }) =>
          item.type === "response_item" ? [item.item.turnId] : [],
        ),
      ).toEqual(["turn_one"])
    }
    await reader.shutdownThread("thread_child")
    expect(await readFile(sourcePath, "utf8")).toBe(`${prefix}${suffix}\n`)
  })

  it("keeps every inherited generation bounded after source metadata deletion", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_source"))
    await store.appendItems("thread_source", [response("turn_root", "root")])
    for (const [source, target] of [
      ["thread_source", "thread_child"],
      ["thread_child", "thread_grandchild"],
    ] as const) {
      const prepared = await store.prepareFork({
        sourceThreadId: source,
        boundary: { type: "latest" },
      })
      await store.createFork({
        prepared,
        target: metadata(target, { parentThreadId: source }),
      })
      await store.appendItems(target, [response(`turn_${target}`, target)])
    }
    for (const id of ["thread_source", "thread_child", "thread_grandchild"]) {
      await store.shutdownThread(id)
    }
    for (const id of ["thread_source", "thread_child"]) {
      await appendFile(
        join(root, "rollouts", id, "rollout.jsonl"),
        "unrelated corrupt suffix\n",
      )
      await store.deleteThread(id)
    }
    const stored = await store.resumeThread("thread_grandchild")
    expect(
      stored?.rollout.flatMap(({ item }) =>
        item.type === "response_item" ? [item.item.turnId] : [],
      ),
    ).toEqual(["turn_root", "turn_thread_child", "turn_thread_grandchild"])
    await store.shutdownThread("thread_grandchild")
  })

  it.each([
    "included corruption",
    "middle of line",
    "blank line cutoff",
    "wrong sequence",
  ])("still rejects an inherited prefix with %s", async (invalid) => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_source"))
    await store.appendItems("thread_source", [
      response("turn_one", "你好 prefix"),
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
    await store.shutdownThread("thread_child")
    const sourcePath = join(root, "rollouts", "thread_source", "rollout.jsonl")
    const childPath = join(root, "rollouts", "thread_child", "rollout.jsonl")
    const childMeta = JSON.parse(
      (await readFile(childPath, "utf8")).trim(),
    ) as {
      item: {
        metadata: {
          historyBase: { endByteOffset: number; endSeqExclusive: number }
        }
      }
    }
    const position = childMeta.item.metadata.historyBase
    if (invalid === "included corruption") {
      const bytes = await readFile(sourcePath)
      bytes[bytes.length - 2] = 120
      await writeFile(sourcePath, bytes)
    } else if (invalid === "middle of line") {
      const bytes = await readFile(sourcePath)
      position.endByteOffset = bytes.indexOf(Buffer.from("你好")) + 1
    } else if (invalid === "blank line cutoff") {
      await appendFile(sourcePath, "\n")
      position.endByteOffset += 1
    } else {
      position.endSeqExclusive += 1
    }
    await writeFile(childPath, `${JSON.stringify(childMeta)}\n`)
    await expect(store.readThread("thread_child")).rejects.toThrow()
    await expect(store.resumeThread("thread_child")).rejects.toThrow()
  })

  it("rejects a forged byte cutoff instead of silently widening history", async () => {
    const { root, store } = await createStore()
    await createPersistentThread(store, metadata("thread_source"))
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
    const childPath = join(root, "rollouts", "thread_child", "rollout.jsonl")
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

function createStoreAssets(root: string, store: JsonlThreadStore) {
  return createRolloutAssets(root, {
    withMutationLease: (rolloutId, mutate) =>
      store.withRolloutAssetMutation(rolloutId, mutate),
  })
}

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

async function createPersistentThread(
  store: JsonlThreadStore,
  input: CreateThreadMetadata,
) {
  const created = await store.createThread(input)
  await store.persistThread(created.metadata.id, "turn_start")
  return created
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-thread-store-"))
  roots.push(root)
  return root
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
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
    await store.persistThread("thread_retry_shutdown", "turn_start");
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
    try { await store.createThread({ id: "thread_create_retry", conversationId: "thread_create_retry", createdAt: now, updatedAt: now }); await store.persistThread("thread_create_retry", "turn_start"); }
    catch (error) { message = error instanceof Error ? error.message : "unknown failure"; }
    prototype.sync = originalSync;
    await probe.close();
    await store.shutdownThread("thread_create_retry");
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
