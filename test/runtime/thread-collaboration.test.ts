import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { PersistContext } from "../../src/core/thread-store.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { createThreadCollaboration } from "../../src/runtime/thread-collaboration.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createThreadCollaborationTools } from "../../src/runtime/tools/thread-collaboration.ts"
import { canonicalToolName } from "../../src/runtime/tools/tool-name.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import {
  createFauxProvider,
  type FauxScriptedResponse,
} from "../support/faux-provider.ts"

async function fixture(script: readonly FauxScriptedResponse[]) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-thread-collaboration-"))
  const provider = createFauxProvider(script)
  const start = () => {
    const store = new JsonlThreadStore({ root })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const service = createThreadCollaboration({
      store,
      getThreadManager: () => manager,
    })
    return { store, manager, service }
  }
  const first = start()
  const source = await first.manager.createThread({
    title: "Source",
    workingDirectory: process.cwd(),
    mateId: "mate",
    mateRevisionId: "revision",
  })
  await first.store.persistThread(source.id, PersistContext.TurnStart)
  const target = await first.manager.createThread({
    title: "Unrelated existing session",
    workingDirectory: process.cwd(),
    mateId: "mate",
    mateRevisionId: "revision",
  })
  await first.store.persistThread(target.id, PersistContext.TurnStart)
  return {
    ...first,
    root,
    source,
    target,
    provider,
    start,
    async cleanup() {
      await first.manager.shutdown()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe("independent session collaboration", () => {
  it("reads selected excerpts and structured tool errors and discovery results without omitting their semantics", async () => {
    const f = await fixture([])
    try {
      const selected = {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Review this" }],
        contextAttachments: [
          {
            id: "selection",

            text: "Important selected paragraph",
            source: {
              kind: "message" as const,
              label: "Source",
              sessionId: "source",
              messageId: "original",
            },
          },
        ],
      }
      const toolResult = {
        role: "tool" as const,
        toolCallId: "discovery",
        content: [{ type: "text" as const, text: "tool error" }],
        isError: true,
        toolSearch: {
          tools: [
            {
              name: "discovered",
              description: "Found tool",
              inputSchema: { type: "object" },
            },
          ],
        },
      }
      await f.store.appendItems(
        f.target.id,
        [selected, toolResult].map((item, index) => ({
          type: "response_item" as const,
          item: {
            id: `semantic_${index}`,
            turnId: "semantic_turn",
            createdAt: "2026-10-11T00:00:00Z",
            item,
          },
        })),
      )
      await f.store.flushThread(f.target.id)
      const page = await f.service
        .bind(f.source.id)
        .read({ threadId: f.target.id, turnId: "semantic_turn" })
      if (!("items" in page)) throw new Error("Expected transcript")
      expect(page.truncated).toBe(false)
      expect(page.items.map((item) => JSON.parse(item.text))).toEqual([
        selected,
        toolResult,
      ])
    } finally {
      await f.cleanup()
    }
  })

  it("treats a fork as a new recipient while preserving readable source history", async () => {
    const f = await fixture([
      { content: [{ type: "text", text: "source result" }] },
      { content: [{ type: "text", text: "later user turn" }] },
      { content: [{ type: "text", text: "new fork result" }] },
    ])
    try {
      const control = f.service.bind(f.source.id)
      const request = {
        threadId: f.target.id,
        requestId: "same_id",
        message: "work",
      }
      const sent = await control.send(request)
      await control.wait([sent], 5_000)
      const later = await f.target.startIfIdle({
        content: createUserInput("fork before this"),
      })
      if (later.type !== "started") throw new Error("Expected later turn")
      await expect.poll(() => f.target.status).toBe("idle")
      const fork = await f.manager.forkThread({
        sourceThreadId: f.target.id,
        beforeTurnId: later.turnId,
      })
      expect(
        await control.wait([{ ...sent, threadId: fork.thread.id }], 0),
      ).toMatchObject({ results: [{ status: "not_found" }] })
      const history = await control.read({
        threadId: fork.thread.id,
        turnId: sent.turnId,
      })
      if (!("items" in history)) throw new Error("Expected transcript")
      expect(history.items.length).toBeGreaterThan(0)
      expect(
        history.items.every((item) => item.originThreadId === f.target.id),
      ).toBe(true)
      expect(JSON.stringify(history)).toContain("source result")
      const newSent = await control.send({
        ...request,
        threadId: fork.thread.id,
      })
      expect(newSent.delivery).toBe("started")
      expect(newSent.turnId).not.toBe(sent.turnId)
      expect(await control.wait([newSent], 5_000)).toMatchObject({
        results: [{ status: "completed", consumed: true }],
      })
      expect(f.provider.callCount).toBe(3)
    } finally {
      await f.cleanup()
    }
  })

  it("preserves a refusal result instead of presenting turn completion as task success", async () => {
    const f = await fixture([
      {
        stopReason: "content_filter",
        content: [{ type: "text", text: "Cannot perform this request." }],
      },
    ])
    try {
      const control = f.service.bind(f.source.id)
      const sent = await control.send({
        threadId: f.target.id,
        requestId: "refused",
        message: "work",
      })
      expect(await control.wait([sent], 5_000)).toMatchObject({
        results: [
          {
            status: "completed",
            consumed: true,
            completionReason: "refused",
            answerItemIds: [expect.any(String)],
          },
        ],
      })
    } finally {
      await f.cleanup()
    }
  })

  it("rechecks a stale history read when the target finishes during that read", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = await fixture([
      {
        assertRequest: async () => {
          entered.resolve()
          await release.promise
        },
        content: [{ type: "text", text: "finished during read" }],
      },
    ])
    const readEntered = Promise.withResolvers<void>(),
      releaseRead = Promise.withResolvers<void>()
    try {
      const control = f.service.bind(f.source.id)
      const sent = await control.send({
        threadId: f.target.id,
        requestId: "stale",
        message: "work",
      })
      await entered.promise
      const originalRead = f.store.readThread.bind(f.store)
      vi.spyOn(f.store, "readThread").mockImplementationOnce(async (id) => {
        const stale = await originalRead(id)
        readEntered.resolve()
        await releaseRead.promise
        return stale
      })
      const waiting = control.wait([sent], 5_000)
      await readEntered.promise
      release.resolve()
      await expect.poll(() => f.target.status).toBe("idle")
      releaseRead.resolve()
      expect(await waiting).toMatchObject({
        reason: "completed",
        results: [{ status: "completed", consumed: true }],
      })
    } finally {
      release.resolve()
      releaseRead.resolve()
      vi.restoreAllMocks()
      await f.cleanup()
    }
  })

  it("honors list limits and prevents independent sends from bypassing subagent ownership", async () => {
    const f = await fixture([])
    try {
      const control = f.service.bind(f.source.id)
      const first = await control.list({ limit: 1 })
      expect(first.threads).toHaveLength(1)
      expect(first.truncated).toBe(true)
      if (first.nextCursor === undefined)
        throw new Error("Expected list cursor")
      const second = await control.list({ limit: 1, cursor: first.nextCursor })
      expect(second.threads).toHaveLength(1)
      expect(second.threads[0]?.threadId).not.toBe(first.threads[0]?.threadId)
      expect(second.truncated).toBe(false)
      const child = await f.manager.createThread({
        parentThreadId: f.target.id,
        conversationId: f.target.id,
        metadata: {
          agent: {
            version: 1,
            kind: "subagent",
            rootThreadId: f.target.id,
            parentThreadId: f.target.id,
            taskName: "child",
            path: "/root/child",
            agentType: "general",
            depth: 1,
          },
        },
      })
      await f.store.persistThread(child.id, PersistContext.TurnStart)
      await f.manager.closeThread(child.id)
      await expect(
        control.send({
          threadId: child.id,
          requestId: "bypass",
          message: "Do work",
        }),
      ).rejects.toMatchObject({ code: "target_is_subagent" })
      expect(f.manager.getThread(child.id)).toBeUndefined()
      expect(f.provider.callCount).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  it("starts an unrelated root, tracks its exact result and replays durably after restart", async () => {
    const f = await fixture([
      { content: [{ type: "text", text: "independent result" }] },
      { content: [{ type: "text", text: "later unrelated answer" }] },
    ])
    let restarted: ReturnType<typeof f.start> | undefined
    try {
      const control = f.service.bind(f.source.id)
      const request = {
        threadId: f.target.id,
        requestId: "stable",
        message: "Find the answer",
      }
      const sent = await control.send(request)
      expect(sent).toMatchObject({
        accepted: true,
        threadId: f.target.id,
        delivery: "started",
      })
      const result = await control.wait([sent], 5_000)
      expect(result).toMatchObject({
        reason: "completed",
        results: [{ status: "completed", consumed: true }],
      })
      const stored = await f.store.readThread(f.target.id)
      expect(stored?.metadata.parentThreadId).toBeUndefined()
      expect(stored?.metadata.conversationId).toBe(f.target.id)
      expect(
        stored?.rollout.filter(
          ({ item }) => item.type === "thread_message_admitted",
        ),
      ).toHaveLength(1)
      const firstInput = f.provider.requests[0]?.messages.find((message) =>
        JSON.stringify(message).includes("Find the answer"),
      )
      expect(firstInput?.role).not.toBe("user")
      expect(JSON.stringify(firstInput)).toContain(f.source.id)
      const read = await control.read({
        threadId: f.target.id,
        turnId: sent.turnId,
      })
      expect(JSON.stringify(read)).toContain("independent result")
      await f.target.startIfIdle({
        content: createUserInput("later user question"),
      })
      await expect.poll(() => f.target.status).toBe("idle")
      expect(await control.wait([sent], 0)).toEqual(result)
      await f.manager.shutdown()
      restarted = f.start()
      const restored = restarted.service.bind(f.source.id)
      expect(await restored.send(request)).toMatchObject({
        ...sent,
        delivery: "replayed",
      })
      expect(await restored.wait([sent], 0)).toEqual(result)
      expect(f.provider.callCount).toBe(2)
      await expect(
        restored.send({ ...request, message: "different payload" }),
      ).rejects.toMatchObject({ code: "request_conflict" })
      expect(
        (await restarted.store.readThread(f.target.id))?.rollout.filter(
          ({ item }) => item.type === "thread_message_admitted",
        ),
      ).toHaveLength(1)
    } finally {
      await restarted?.manager.shutdown()
      await f.cleanup()
    }
  })

  it("steers a busy root without starting another turn and distinguishes timeout and cancellation", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = await fixture([
      {
        assertRequest: async () => {
          entered.resolve()
          await release.promise
        },
        content: [{ type: "text", text: "first sample" }],
      },
      { content: [{ type: "text", text: "handled steering" }] },
    ])
    try {
      const original = await f.target.startIfIdle({
        content: createUserInput("user work"),
      })
      if (original.type !== "started") throw new Error("Expected start")
      await entered.promise
      const control = f.service.bind(f.source.id)
      const sent = await control.send({
        threadId: f.target.id,
        requestId: "busy",
        message: "Additional independent work",
      })
      expect(sent).toMatchObject({
        delivery: "steered",
        turnId: original.turnId,
      })
      expect(await control.wait([sent], 0)).toMatchObject({
        reason: "timeout",
        results: [{ status: "running", consumed: false }],
      })
      const abort = new AbortController()
      const waiting = control.wait([sent], 5_000, abort.signal)
      abort.abort()
      expect(await waiting).toMatchObject({
        reason: "aborted",
        results: [{ status: "running" }],
      })
      expect(f.target.status).toBe("active")
      release.resolve()
      expect(await control.wait([sent], 5_000)).toMatchObject({
        reason: "completed",
        results: [{ status: "completed", consumed: true }],
      })
      expect(
        JSON.stringify(
          await control.read({ threadId: f.target.id, turnId: sent.turnId }),
        ),
      ).toContain("Additional independent work")
      const stored = await f.store.readThread(f.target.id)
      expect(
        stored?.rollout.filter(({ item }) => item.type === "turn_started"),
      ).toHaveLength(1)
      expect(JSON.stringify(f.provider.requests[1]?.messages)).toContain(
        "Additional independent work",
      )
    } finally {
      release.resolve()
      await f.cleanup()
    }
  })

  it("reports an unconsumed cancelled message as incomplete, never as a completed task", async () => {
    const entered = Promise.withResolvers<void>()
    const f = await fixture([
      { assertRequest: () => entered.resolve(), waitForAbort: true },
    ])
    try {
      const control = f.service.bind(f.source.id)
      await f.target.startIfIdle({ content: createUserInput("hold") })
      await entered.promise
      const sent = await control.send({
        threadId: f.target.id,
        requestId: "cancelled",
        message: "not yet sampled",
      })
      await f.target.interruptTurn(sent.turnId)
      await expect.poll(() => f.target.status).toBe("idle")
      expect(await control.wait([sent], 0)).toMatchObject({
        results: [{ status: "delivery_incomplete", consumed: false }],
      })
      expect(
        await control.wait([{ ...sent, turnId: "unrelated" }], 0),
      ).toMatchObject({ results: [{ status: "not_found" }] })
      await expect(
        control.send({
          threadId: f.source.id,
          requestId: "self",
          message: "self",
        }),
      ).rejects.toMatchObject({ code: "self_target" })
    } finally {
      await f.cleanup()
    }
  })

  it("finds a body-only hit and returns every character with precise item IDs and snapshot cursors", async () => {
    const f = await fixture([])
    try {
      const text = `body needle ${"😀long\n".repeat(4000)}`
      await f.store.appendItems(f.target.id, [
        {
          type: "response_item",
          item: {
            id: "input_exact",
            turnId: "turn_exact",
            createdAt: "2026-10-11T00:00:00Z",
            item: { role: "user", content: [{ type: "text", text }] },
          },
        },
      ])
      await f.store.flushThread(f.target.id)
      const control = f.service.bind(f.source.id)
      expect(await control.list({ searchTerm: "needle" })).toMatchObject({
        threads: [{ threadId: f.target.id }],
        truncated: false,
      })
      const occurrences = await control.read({
        threadId: f.target.id,
        searchTerm: "needle",
      })
      expect(occurrences).toMatchObject({
        occurrences: [{ itemId: "input_exact", turnId: "turn_exact" }],
      })
      let page = await control.read({
        threadId: f.target.id,
        itemId: "input_exact",
        maxCharacters: 997,
      })
      if (!("items" in page)) throw new Error("Expected transcript")
      const chunks: string[] = []
      const cursor = page.nextCursor
      expect(cursor).toBeTypeOf("string")
      if (cursor === undefined) throw new Error("Expected continuation cursor")
      await f.store.appendItems(f.target.id, [
        {
          type: "response_item",
          item: {
            id: "later",
            turnId: "later_turn",
            createdAt: "2026-10-11T00:01:00Z",
            item: {
              role: "user",
              content: [{ type: "text", text: "new after snapshot" }],
            },
          },
        },
      ])
      for (;;) {
        if (!("items" in page)) throw new Error("Expected transcript")
        expect(page.items[0]?.offset).toBe(chunks.join("").length)
        chunks.push(...page.items.map((item) => item.text))
        if (!page.truncated) break
        if (page.nextCursor === undefined)
          throw new Error("Expected next cursor")
        page = await control.read({
          threadId: f.target.id,
          itemId: "input_exact",
          cursor: page.nextCursor,
          maxCharacters: 997,
        })
      }
      expect(page).toMatchObject({
        snapshot: { itemCount: 1, newerItemsAvailable: true },
      })
      expect(JSON.parse(chunks.join(""))).toEqual({
        role: "user",
        content: [{ type: "text", text }],
      })
      await expect(
        control.read({ threadId: f.source.id, itemId: "input_exact", cursor }),
      ).rejects.toMatchObject({ code: "invalid_cursor" })
      const tool = createThreadCollaborationTools().find(
        (tool) => canonicalToolName(tool.toolName) === "read_thread",
      )
      if (tool === undefined) throw new Error("Missing read tool")
      const result = await tool.execute(
        { thread_id: f.target.id, item_id: "input_exact" },
        { workspaceRoot: process.cwd(), threadCollaboration: control },
      )
      expect(result.ok).toBe(true)
      const projected = await result.presentation?.toModelContent({
        maxBytes: 800,
        maxLines: 10,
      })
      expect(JSON.stringify(projected)).toContain("retry")
      expect(projected?.toolContentTruncated).toBe(true)
    } finally {
      await f.cleanup()
    }
  })
})
