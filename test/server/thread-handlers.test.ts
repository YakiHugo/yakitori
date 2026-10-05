import { execFile } from "node:child_process"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { PersistContext } from "../../src/core/thread-store.ts"
import {
  createYakitoriError,
  YakitoriErrorCode,
} from "../../src/kernel/errors.ts"
import { isKernelEvent } from "../../src/kernel/events.ts"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"
import { HookEvent, type HookRunner } from "../../src/runtime/hooks.ts"
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createSkillsLoader } from "../../src/runtime/skills.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createSessionEventHub } from "../../src/server/event-hub.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { InputQueue } from "../../src/server/input-queue.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"
import { createFauxProvider } from "../support/faux-provider.ts"
import { waitForValue } from "../support/wait-for-value.ts"

const testUserHome = vi.hoisted(() => ({ path: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testUserHome.path,
}))
beforeEach(async () => {
  testUserHome.path = await mkdtemp(join(tmpdir(), "yakitori-handler-home-"))
})

const cleanups: Array<() => Promise<void>> = []
const executeFile = promisify(execFile)

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(testUserHome.path, { recursive: true, force: true })
})

describe("thread server handlers", () => {
  it("rejects legacy live shapes and applies a single UTF-8 byte budget across all text parts", async () => {
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([
            { content: [{ type: "text", text: "done" }] },
          ]).stream,
          toolRegistry: createToolRegistry([]),
        }),
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      maxInputBytes: 3,
    })
    cleanups.push(async () => {
      await handlers.close()
      await manager.shutdown()
    })
    for (const method of [
      handlers.admitInput,
      handlers.queueInput,
      handlers.steerInput,
    ]) {
      const request = {
        sessionId: "session_00000000-0000-4000-8000-000000000000",
        requestId: "request_budget",
        expectedTurnId: "turn_budget",
      }
      expect(
        await method({ ...request, content: { kind: "text", text: "x" } }),
      ).toMatchObject({ ok: false, status: 400 })
      expect(
        await method({
          ...request,
          content: {
            kind: "parts",
            parts: [
              { type: "text", text: "é" },
              { type: "text", text: "é" },
            ],
          },
        }),
      ).toMatchObject({
        ok: false,
        status: 400,
        body: { error: { details: { field: "content.parts", maxBytes: 3 } } },
      })
      expect(
        await method({
          ...request,
          content: {
            kind: "parts",
            parts: [{ type: "audio", data: "unsupported" }],
          },
        }),
      ).toMatchObject({ ok: false, status: 400 })
      expect(
        await method({
          ...request,
          content: { kind: "parts", parts: [], text: "parallel" },
        }),
      ).toMatchObject({ ok: false, status: 400 })
    }
  })

  it("runs manual compaction through the live Session and recovers its checkpoint and request replay", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-compact-"))
    const store = new JsonlThreadStore({ root: join(workspace, "store") })
    let requests = 0
    let releaseCompaction!: () => void
    const compactionGate = new Promise<void>((resolve) => {
      releaseCompaction = resolve
    })
    const stream: StreamFn = async function* () {
      requests += 1
      if (requests === 2) await compactionGate
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [
            {
              type: "text",
              text: requests === 1 ? "original answer" : "durable summary",
            },
          ],
        },
      }
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      releaseCompaction()
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const first = await handlers.admitInput({
      sessionId,
      requestId: "request_before_compact",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Remember the goal" }],
      },
    })
    if (!first.ok) throw new Error(first.body.error.message)
    const thread = manager.getThread(sessionId)
    if (thread === undefined) throw new Error("Missing live Session.")
    await waitForValue(() =>
      typeof thread.agentStatus === "object" &&
      "completed" in thread.agentStatus
        ? true
        : undefined,
    )

    const compact = await handlers.compactSession({
      sessionId,
      requestId: "request_manual_compact",
    })
    if (!compact.ok) throw new Error(compact.body.error.message)
    expect(compact.status).toBe(201)
    expect(compact.body).toMatchObject({
      requestId: "request_manual_compact",
      turnId: "request_manual_compact",
    })
    const replay = await handlers.compactSession({
      sessionId,
      requestId: "request_manual_compact",
    })
    expect(replay).toMatchObject({
      ok: true,
      status: 200,
      body: { turnId: compact.body.turnId },
    })
    const busy = await handlers.compactSession({
      sessionId,
      requestId: "request_manual_compact_again",
    })
    expect(busy).toMatchObject({
      ok: false,
      status: 409,
    })
    const incompatibleReplay = await handlers.admitInput({
      sessionId,
      requestId: "request_manual_compact",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "/compact" }],
      },
    })
    expect(incompatibleReplay).toMatchObject({
      ok: false,
      status: 409,
    })
    releaseCompaction()
    await waitForValue(() =>
      thread.status === "idle" &&
      typeof thread.agentStatus === "object" &&
      "completed" in thread.agentStatus
        ? true
        : undefined,
    )
    expect(requests).toBe(2)
    const saved = await store.readThread(sessionId)
    expect(
      saved?.rollout.find(
        ({ item }) =>
          item.type === "compacted" && item.turnId === "request_manual_compact",
      )?.item,
    ).toMatchObject({
      type: "compacted",
      summary: "durable summary",
    })
    expect(
      saved?.rollout.find(
        ({ item }) =>
          item.type === "turn_completed" &&
          item.turnId === "request_manual_compact",
      )?.item,
    ).toMatchObject({
      outcome: "completed",
      metrics: { modelCalls: 1, toolCalls: 0 },
    })
    expect(
      saved?.rollout.some(
        ({ item }) =>
          item.type === "item_completed" &&
          item.turnId === "request_manual_compact" &&
          item.item.type === "context_compaction" &&
          item.item.status === "completed",
      ),
    ).toBe(true)
    const events = await handlers.readSessionEvents({ sessionId })
    if (!events.ok) throw new Error(events.body.error.message)
    expect(events.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "rollout.item",
          data: {
            item: expect.objectContaining({
              type: "compacted",
              turnId: "request_manual_compact",
            }),
          },
        }),
        expect.objectContaining({
          type: "item.completed",
          data: {
            turnId: "request_manual_compact",
            item: expect.objectContaining({
              type: "context_compaction",
              status: "completed",
            }),
          },
        }),
      ]),
    )
    await manager.closeThread(sessionId)
    const resumed = await manager.resumeThread(sessionId)
    expect(
      resumed
        ?.snapshot()
        .context.history.some(
          ({ item }) =>
            item.role === "user" &&
            item.content.some(
              (block) => block.type === "text" && block.text === "/compact",
            ),
        ),
    ).toBe(false)
    expect(
      (await store.readThread(sessionId))?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.turnId === "request_manual_compact" &&
          item.item.item.role === "user",
      ),
    ).toBe(false)
    expect(resumed?.snapshot().context.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                text: expect.stringContaining("durable summary"),
              }),
            ],
          }),
        }),
      ]),
    )
    const resumedReplay = await handlers.compactSession({
      sessionId,
      requestId: "request_manual_compact",
    })
    expect(resumedReplay).toMatchObject({
      ok: true,
      status: 200,
      body: { turnId: compact.body.turnId },
    })
    expect(requests).toBe(2)
  })

  it("reads prior turn cache policy from the durable rollout after the selected model changes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-cache-"))
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([]).stream,
          toolRegistry: createToolRegistry([]),
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const empty = await handlers.readSession({ sessionId })
    if (!empty.ok) throw new Error(empty.body.error.message)
    expect(empty.body.session.cacheExpiry).toBeUndefined()

    await store.appendItems(sessionId, [
      {
        type: "turn_context",
        context: {
          turnId: "turn_anthropic",
          selection: { provider: "anthropic", model: "claude-sonnet-4-6" },
          configuration: {} as never,
        },
      },
      {
        type: "turn_completed",
        turnId: "turn_anthropic",
        outcome: "completed",
        lastRequestStartedAt: "2026-09-20T10:00:00.000Z",
      },
      {
        type: "turn_context",
        context: {
          turnId: "turn_openai",
          selection: { provider: "openai", model: "gpt-6-sol" },
          configuration: {} as never,
        },
      },
    ])
    const stored = await store.readThread(sessionId)
    const completedAt = stored?.rollout.find(
      ({ item }) =>
        item.type === "turn_completed" && item.turnId === "turn_anthropic",
    )?.createdAt
    if (completedAt === undefined)
      throw new Error("Missing durable completion.")
    const read = await handlers.readSession({ sessionId })
    if (!read.ok) throw new Error(read.body.error.message)
    expect(read.body.session.currentModel?.provider).toBe("openai")
    expect(read.body.session.cacheExpiry).toEqual({
      provider: "anthropic",
      lastTurnCompletedAt: completedAt,
      lastRequestStartedAt: "2026-09-20T10:00:00.000Z",
      ttlDescription: "5 minutes after last use",
      expiresAt: "2026-09-20T10:05:00.000Z",
      status: "estimated",
    })
  })

  it("captures Git identity when the session is created", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-git-"))
    const git = (args: readonly string[]) =>
      executeFile(
        "git",
        [
          "-C",
          workspace,
          "-c",
          "user.name=Handler Test",
          "-c",
          "user.email=handler@example.test",
          ...args,
        ],
        { encoding: "utf8" },
      )
    await git(["init", "--quiet"])
    await writeFile(join(workspace, "tracked.txt"), "tracked\n")
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", "initial"])
    await git(["branch", "-M", "feat/session-context"])
    await git([
      "remote",
      "add",
      "origin",
      "https://github.com/example/project.git",
    ])
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim()
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([]).stream,
          toolRegistry: createToolRegistry([]),
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })

    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })

    if (!created.ok) throw new Error(created.body.error.message)
    expect(created.body.session.gitInfo).toEqual({
      sha,
      branch: "feat/session-context",
      originUrl: "https://github.com/example/project.git",
    })
    expect(
      (await store.readThread(created.body.session.id))?.metadata.gitInfo,
    ).toEqual(created.body.session.gitInfo)
  })

  it("steers input into an active turn and rejects steering an idle session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-steer-"))
    const store = new MemoryThreadStore()
    const requests: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const stream: StreamFn = async function* (request) {
      const text = request.messages
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
      requests.push(text)
      if (requests.length === 1) await firstGate
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "ok" }],
        },
      }
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })

    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id

    const idle = await handlers.steerInput({
      sessionId,
      requestId: "request_idle_steer",
      expectedTurnId: "turn_missing",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "nothing to steer" }],
      },
    })
    expect(idle.ok).toBe(false)
    if (!idle.ok) expect(idle.body.error.message).toContain("no_active_turn")

    const admitted = await handlers.admitInput({
      sessionId,
      requestId: "request_first",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "start the work" }],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await waitForValue(() => (requests.length === 1 ? true : undefined))

    const wrongTurn = await handlers.steerInput({
      sessionId,
      requestId: "request_wrong_turn",
      expectedTurnId: "turn_other",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "wrong target" }],
      },
    })
    expect(wrongTurn.ok).toBe(false)
    if (!wrongTurn.ok)
      expect(wrongTurn.body.error.message).toContain("turn_mismatch")

    const steered = await handlers.steerInput({
      sessionId,
      requestId: "request_steer",
      expectedTurnId: "request_first",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "also handle this" }],
      },
    })
    if (!steered.ok) throw new Error(steered.body.error.message)
    expect(steered.body.turnId).toBe("request_first")

    releaseFirst()
    await waitForValue(() =>
      manager.getThread(sessionId)?.status === "idle" ? true : undefined,
    )

    // The steered input joined the same Turn: the next sampling saw it and
    // the rollout records it durably.
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("also handle this")
    const events = await handlers.readSessionEvents({ sessionId })
    if (!events.ok) throw new Error(events.body.error.message)
    expect(
      events.body.events.find(
        (event) =>
          isKernelEvent(event) &&
          event.type === "input.admitted" &&
          event.data.steered === true,
      ),
    ).toMatchObject({
      type: "input.admitted",
      data: {
        steered: true,
        content: {
          kind: "parts" as const,
          parts: [{ type: "text" as const, text: "also handle this" }],
        },
      },
    })
  })

  it("queues input durably while a turn runs and cancels it through the RPC", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-queue-"))
    const store = new MemoryThreadStore()
    const rolloutAssets = createRolloutAssets(workspace, {
      async withMutationLease(_rolloutId, mutate) {
        return mutate()
      },
    })
    const requests: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const stream: StreamFn = async function* (request) {
      const text = request.messages
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
      requests.push(text)
      if (requests.length === 1) await firstGate
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "ok" }],
        },
      }
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
          rolloutAssets,
        }),
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      rolloutAssets,
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })

    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id

    const admitted = await handlers.admitInput({
      sessionId,
      requestId: "request_first",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "start the work" }],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await waitForValue(() => (requests.length === 1 ? true : undefined))

    await mkdir(join(workspace, "rollouts", sessionId), { recursive: true })
    const attachments = await rolloutAssets.importImageBytes(
      sessionId,
      "draft_queue_cancel",
      [{ name: "queued.png", data: pngBytes() }],
    )

    const queued = await handlers.queueInput({
      sessionId,
      requestId: "request_queued",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "run after" },
          ...attachments.map((image) => ({ type: "image" as const, ...image })),
        ],
      },
    })
    if (!queued.ok) throw new Error(queued.body.error.message)
    expect(queued.status).toBe(201)
    const queuedEvents = await handlers.readSessionEvents({ sessionId })
    if (!queuedEvents.ok) throw new Error(queuedEvents.body.error.message)
    expect(
      queuedEvents.body.events.some((event) => event.type === "input.queued"),
    ).toBe(false)
    const queuedList = await handlers.listQueuedInputs({ sessionId })
    if (!queuedList.ok) throw new Error(queuedList.body.error.message)
    expect(queuedList.body.items).toEqual([
      expect.objectContaining({
        id: queued.body.inputId,
        input: expect.objectContaining({
          content: expect.objectContaining({
            parts: [
              { type: "text", text: "run after" },
              expect.objectContaining({ type: "image", name: "queued.png" }),
            ],
          }),
        }),
      }),
    ])
    expect(
      (await store.readThread(sessionId))?.rollout.some(
        ({ item }) =>
          item.type === "response_item" && item.item.id === queued.body.inputId,
      ),
    ).toBe(false)

    const editedAttachments = await rolloutAssets.importImageBytes(
      sessionId,
      "draft_queue_edit",
      [{ name: "edited.png", data: pngBytes() }],
    )
    const edited = await handlers.updateQueuedInput({
      sessionId,
      inputId: queued.body.inputId,
      requestId: "request_queued_edit",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "run after" },
          ...editedAttachments.map((image) => ({
            type: "image" as const,
            ...image,
          })),
        ],
      },
    })
    if (!edited.ok) throw new Error(edited.body.error.message)
    expect(edited.body.item.input.submissionId).toBe("request_queued")
    await expect(
      rolloutAssets.read({
        rolloutId: sessionId,
        path: "attachments/requests/request_queued/1.png",
      }),
    ).rejects.toMatchObject({ code: "ENOENT" })

    const detail = await handlers.readSession({ sessionId })
    if (!detail.ok) throw new Error(detail.body.error.message)
    expect(detail.body.session.pendingInputs).toEqual([
      expect.objectContaining({ text: "run after" }),
    ])
    expect(detail.body.session.counts.inputs).toBe(1)
    const queuedInputId = detail.body.session.pendingInputs[0]?.id
    if (queuedInputId === undefined) throw new Error("Missing queued input.")

    const cancelled = await handlers.cancelInput({
      sessionId,
      inputId: queuedInputId,
      reason: "user_cancel",
    })
    if (!cancelled.ok) throw new Error(cancelled.body.error.message)
    expect((await handlers.listQueuedInputs({ sessionId })).ok).toBe(true)
    await expect(
      rolloutAssets.read({
        rolloutId: sessionId,
        path: "attachments/requests/request_queued_edit/1.png",
      }),
    ).rejects.toMatchObject({ code: "ENOENT" })

    const after = await handlers.readSession({ sessionId })
    if (!after.ok) throw new Error(after.body.error.message)
    expect(after.body.session.pendingInputs).toEqual([])

    // Cancelling an already-started or unknown input conflicts.
    const missing = await handlers.cancelInput({
      sessionId,
      inputId: queuedInputId,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.status).toBe(409)

    const nextAttachments = await rolloutAssets.importImageBytes(
      sessionId,
      "draft_queue_dispatch",
      [{ name: "original-name.png", data: pngBytes() }],
    )
    const next = await handlers.queueInput({
      sessionId,
      requestId: "request_dispatched",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "run second" },
          ...nextAttachments.map((image) => ({
            type: "image" as const,
            ...image,
          })),
        ],
      },
    })
    if (!next.ok) throw new Error(next.body.error.message)
    releaseFirst()
    await waitForValue(() =>
      requests.length === 2 && manager.getThread(sessionId)?.status === "idle"
        ? true
        : undefined,
    )
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain("start the work")
    expect(requests[1]).toContain("run second")
    expect(requests[1]).not.toContain("run after")
    const replay = await handlers.readSessionEvents({ sessionId })
    if (!replay.ok) throw new Error(replay.body.error.message)
    const admittedNext = replay.body.events.filter(
      (event) =>
        event.type === "input.admitted" &&
        isKernelEvent(event) &&
        event.data.requestId === "request_dispatched",
    )
    expect(admittedNext).toHaveLength(1)
    expect(admittedNext[0]).toMatchObject({
      data: {
        content: {
          parts: [
            { type: "text", text: "run second" },
            expect.objectContaining({
              type: "image",
              name: "original-name.png",
            }),
          ],
        },
      },
    })
  })

  it("leaves queued input waiting after interruption until a later turn completes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-queue-interrupt-"))
    const store = new MemoryThreadStore()
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<void>()
    const requests: string[] = []
    const stream: StreamFn = async function* (request) {
      const text = request.messages
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .filter((value) => ["first", "manual", "queued"].includes(value))
        .at(-1)
      if (text !== undefined) requests.push(text)
      if (requests.length === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      releaseFirst.resolve()
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const first = await handlers.admitInput({
      sessionId,
      requestId: "request_interrupt_first",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "first" }],
      },
    })
    if (!first.ok) throw new Error(first.body.error.message)
    await firstStarted.promise
    const queued = await handlers.queueInput({
      sessionId,
      requestId: "request_interrupt_queued",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "queued" }],
      },
    })
    if (!queued.ok) throw new Error(queued.body.error.message)
    const interrupted = await handlers.cancelTurn({
      sessionId,
      turnId: "request_interrupt_first",
    })
    if (!interrupted.ok) throw new Error(interrupted.body.error.message)
    releaseFirst.resolve()
    await waitForValue(() =>
      manager.getThread(sessionId)?.agentStatus === "interrupted" &&
      manager.getThread(sessionId)?.status === "idle"
        ? true
        : undefined,
    )
    expect(requests).toEqual(["first"])
    const waiting = await handlers.listQueuedInputs({ sessionId })
    if (!waiting.ok) throw new Error(waiting.body.error.message)
    expect(waiting.body.items.map((item) => item.id)).toEqual([
      queued.body.inputId,
    ])

    expect(await manager.closeThread(sessionId)).toBe(true)
    expect(await manager.resumeThread(sessionId)).toBeDefined()
    await Promise.resolve()
    expect(requests).toEqual(["first"])

    const manual = await handlers.admitInput({
      sessionId,
      requestId: "request_interrupt_manual",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "manual" }],
      },
    })
    if (!manual.ok) throw new Error(manual.body.error.message)
    await waitForValue(() => (requests.length === 3 ? true : undefined))
    expect(requests).toEqual(["first", "manual", "queued"])
    const drained = await handlers.listQueuedInputs({ sessionId })
    if (!drained.ok) throw new Error(drained.body.error.message)
    expect(drained.body.items).toEqual([])
  })

  it("queues a cold thread without resuming it and dispatches on resume", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-queue-resume-"))
    const store = new MemoryThreadStore()
    const queue = new InputQueue()
    const rolloutAssets = createRolloutAssets(workspace, {
      async withMutationLease(_rolloutId, mutate) {
        return mutate()
      },
    })
    const seen: string[] = []
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: async function* (request) {
            const text = request.messages
              .flatMap((message) =>
                message.role === "user" ? message.content : [],
              )
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .find((value) => value === "after resume")
            if (text !== undefined) seen.push(text)
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "done" }],
              },
            }
          },
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
          rolloutAssets,
        }),
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      inputQueue: queue,
      rolloutAssets,
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      queue.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    expect(await manager.closeThread(sessionId)).toBe(true)
    await mkdir(join(workspace, "rollouts", sessionId), { recursive: true })
    const attachment = await rolloutAssets.importImageBytes(
      sessionId,
      "draft_cold_queue",
      [{ name: "cold.png", data: pngBytes() }],
    )
    const queued = await handlers.queueInput({
      sessionId,
      requestId: "request_after_resume",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "after resume" },
          ...attachment.map((image) => ({ type: "image" as const, ...image })),
        ],
      },
    })
    if (!queued.ok) throw new Error(queued.body.error.message)
    expect(manager.getThread(sessionId)).toBeUndefined()
    expect(seen).toEqual([])
    expect(queue.list(sessionId)).toHaveLength(1)
    await expect(
      rolloutAssets.read({
        rolloutId: sessionId,
        path: "attachments/requests/request_after_resume/1.png",
      }),
    ).resolves.toEqual(pngBytes())
    const longText = await handlers.queueInput({
      sessionId,
      requestId: "request_long_queue_text",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "x".repeat(300_000) }],
      },
    })
    if (!longText.ok) throw new Error(longText.body.error.message)
    expect(queue.list(sessionId)).toHaveLength(2)
    expect(
      await handlers.queueInput({
        sessionId,
        requestId: "request_queue_text_over_limit",
        content: {
          kind: "parts" as const,
          parts: [{ type: "text" as const, text: "x".repeat(1_048_577) }],
        },
      }),
    ).toMatchObject({ ok: false, status: 400 })
    expect(
      await handlers.cancelInput({ sessionId, inputId: longText.body.inputId }),
    ).toMatchObject({ ok: true })
    expect(await handlers.startQueuedInput({ sessionId })).toMatchObject({
      ok: false,
      status: 409,
    })

    expect(await manager.resumeThread(sessionId)).toBeDefined()
    await waitForValue(() => (seen.length === 1 ? true : undefined))
    expect(seen).toEqual(["after resume"])
    const drained = await handlers.listQueuedInputs({ sessionId })
    if (!drained.ok) throw new Error(drained.body.error.message)
    expect(drained.body.items).toEqual([])
  })

  it("keeps a queued prompt out of history when its hook blocks dispatch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-queued-hook-"))
    const store = new MemoryThreadStore()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let modelCalls = 0
    const hookRunner: HookRunner = {
      async dispose() {},
      async run(request) {
        return {
          continue:
            request.event !== HookEvent.UserPromptSubmit ||
            request.payload.prompt !== "blocked queued input",
          additionalContext: [],
        }
      },
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: async function* () {
            modelCalls += 1
            await firstGate
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "done" }],
              },
            }
          },
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
          hookRunner,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const started = await handlers.admitInput({
      sessionId,
      requestId: "request_running_before_block",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "running input" }],
      },
    })
    if (!started.ok) throw new Error(started.body.error.message)
    await waitForValue(() => (modelCalls === 1 ? true : undefined))
    const queued = await handlers.queueInput({
      sessionId,
      requestId: "request_blocked_queued",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "blocked queued input" }],
      },
    })
    if (!queued.ok) throw new Error(queued.body.error.message)
    const beforeDispatch = await handlers.readSessionEvents({ sessionId })
    if (!beforeDispatch.ok) throw new Error(beforeDispatch.body.error.message)
    expect(
      beforeDispatch.body.events
        .filter(
          (event) =>
            isKernelEvent(event) &&
            "requestId" in event.data &&
            event.data.requestId === "request_blocked_queued",
        )
        .map((event) => event.type),
    ).toEqual([])

    releaseFirst()
    await expect
      .poll(async () =>
        (await store.readThread(sessionId))?.rollout.some(
          ({ item }) =>
            item.type === "turn_completed" &&
            item.turnId === "request_blocked_queued",
        ),
      )
      .toBe(true)
    expect(modelCalls).toBe(1)
    const afterDispatch = await handlers.readSessionEvents({ sessionId })
    if (!afterDispatch.ok) throw new Error(afterDispatch.body.error.message)
    expect(
      afterDispatch.body.events.filter(
        (event) =>
          isKernelEvent(event) &&
          event.type === "input.admitted" &&
          event.data.requestId === "request_blocked_queued",
      ),
    ).toEqual([])
    const detail = await handlers.readSession({ sessionId })
    if (!detail.ok) throw new Error(detail.body.error.message)
    expect(detail.body.session.pendingInputs).toEqual([])
    expect(detail.body.session.counts.inputs).toBe(1)
  })

  it("updates and reorders waiting inputs before automatic dispatch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-queue-order-"))
    const store = new MemoryThreadStore()
    const seen: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: async function* (request) {
            const text =
              request.messages
                .flatMap((message) =>
                  message.role === "user" ? message.content : [],
                )
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .at(-1) ?? ""
            seen.push(text)
            if (seen.length === 1) await firstGate
            yield {
              type: "response",
              response: {
                stopReason: ModelStopReason.EndTurn,
                content: [{ type: "text", text: "ok" }],
              },
            }
          },
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      releaseFirst()
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const first = await handlers.admitInput({
      sessionId,
      requestId: "request_running",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "running" }],
      },
    })
    if (!first.ok) throw new Error(first.body.error.message)
    await waitForValue(() => (seen.length === 1 ? true : undefined))
    const a = await handlers.queueInput({
      sessionId,
      requestId: "request_a",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "a" }],
      },
    })
    const b = await handlers.queueInput({
      sessionId,
      requestId: "request_b",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "b" }],
      },
    })
    if (!a.ok || !b.ok) throw new Error("Queue admission failed")
    const editedInPlace = await handlers.updateQueuedInput({
      sessionId,
      inputId: a.body.inputId,
      requestId: "request_a",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "changed in place" }],
      },
    })
    if (!editedInPlace.ok) throw new Error(editedInPlace.body.error.message)
    expect(editedInPlace.body.item.input.submissionId).toBe("request_a")
    const editedWithAnotherRequestId = await handlers.updateQueuedInput({
      sessionId,
      inputId: a.body.inputId,
      requestId: "request_b",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "changed again" }],
      },
    })
    if (!editedWithAnotherRequestId.ok)
      throw new Error(editedWithAnotherRequestId.body.error.message)
    expect(editedWithAnotherRequestId.body.item.input.submissionId).toBe(
      "request_a",
    )
    expect(
      await handlers.reorderQueuedInputs({
        sessionId,
        inputIds: [a.body.inputId],
      }),
    ).toMatchObject({ ok: false, status: 400 })
    const updated = await handlers.updateQueuedInput({
      sessionId,
      inputId: a.body.inputId,
      requestId: "request_a_edited",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "a edited" }],
      },
    })
    if (!updated.ok) throw new Error(updated.body.error.message)
    expect(updated.body.item.id).toBe(a.body.inputId)
    expect(updated.body.item.input.submissionId).toBe("request_a")
    const reordered = await handlers.reorderQueuedInputs({
      sessionId,
      inputIds: [b.body.inputId, a.body.inputId],
    })
    if (!reordered.ok) throw new Error(reordered.body.error.message)
    expect(reordered.body.items.map((item) => item.id)).toEqual([
      b.body.inputId,
      a.body.inputId,
    ])
    const busyStart = await handlers.startQueuedInput({
      sessionId,
      inputId: a.body.inputId,
    })
    expect(busyStart).toMatchObject({ ok: false, status: 409 })
    expect(
      (await store.readThread(sessionId))?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.turnId === "request_a_edited",
      ),
    ).toBe(false)
    releaseFirst()
    await waitForValue(() => (seen.length === 3 ? true : undefined))
    expect(seen.slice(1)).toEqual(["b", "a edited"])
    expect(
      (await store.readThread(sessionId))?.rollout.some(
        ({ item }) =>
          item.type === "response_item" && item.item.turnId === "request_a",
      ),
    ).toBe(true)
    const listed = await handlers.listQueuedInputs({ sessionId })
    if (!listed.ok) throw new Error(listed.body.error.message)
    expect(listed.body.items).toEqual([])
  })

  it("returns healthy search results with an explicit count of unreadable sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-partial-search-"))
    const original = new JsonlThreadStore({ root })
    for (const id of ["session_healthy", "session_unreadable"]) {
      await original.createThread({
        id,
        conversationId: id,
        title: "searchable project conversation",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      })
      await original.persistThread(id, PersistContext.TurnStart)
      await original.shutdownThread(id)
    }
    await appendFile(
      join(root, "rollouts", "session_unreadable", "rollout.jsonl"),
      '{"invalid":"rollout item"}\n',
    )
    const store = new JsonlThreadStore({ root })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([]).stream,
          toolRegistry: createToolRegistry([]),
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(root, { recursive: true, force: true })
    })

    const result = await handlers.searchSessions({ searchTerm: "project" })
    if (!result.ok) throw new Error(result.body.error.message)
    expect(result.body.data.map(({ session }) => session.id)).toEqual([
      "session_healthy",
    ])
    expect(result.body.unavailableSessionCount).toBe(1)

    const archived = await handlers.searchSessions({
      searchTerm: "project",
      archived: true,
    })
    if (!archived.ok) throw new Error(archived.body.error.message)
    expect(archived.body).toEqual({ data: [] })
  })

  it("searches durable visible history after a Session is closed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-search-"))
    const store = new MemoryThreadStore()
    const provider = createFauxProvider([
      { content: [{ type: "text", text: "Final NEEDLE response" }] },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      title: "searchable task",
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const admitted = await handlers.admitInput({
      sessionId,
      requestId: "request_search",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "A needle in user text" }],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await waitForValue(() =>
      manager.getThread(sessionId)?.status === "idle" ? true : undefined,
    )
    const closed = await handlers.closeSession({ sessionId })
    if (!closed.ok) throw new Error(closed.body.error.message)
    expect(manager.getThread(sessionId)).toBeUndefined()

    const searched = await handlers.searchSessions({
      searchTerm: "NeEdLe",
      limit: 10,
    })
    if (!searched.ok) throw new Error(searched.body.error.message)
    expect(searched.body.data).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({ id: sessionId }),
        snippet: "A needle in user text",
      }),
    ])

    const firstPage = await handlers.searchSessionOccurrences({
      sessionId,
      searchTerm: "needle",
      limit: 1,
    })
    if (!firstPage.ok) throw new Error(firstPage.body.error.message)
    expect(firstPage.body.data).toEqual([
      expect.objectContaining({
        itemId: admitted.body.inputId,
        snippet: "A needle in user text",
        snippetMatchRange: { start: 2, end: 8 },
      }),
    ])
    expect(firstPage.body.nextCursor).toBeTypeOf("string")
    const secondPage = await handlers.searchSessionOccurrences({
      sessionId,
      searchTerm: "needle",
      limit: 1,
      cursor: firstPage.body.nextCursor,
    })
    if (!secondPage.ok) throw new Error(secondPage.body.error.message)
    expect(secondPage.body.data).toEqual([
      expect.objectContaining({
        snippet: "Final NEEDLE response",
        snippetMatchRange: { start: 6, end: 12 },
      }),
    ])
    expect(secondPage.body.nextCursor).toBeUndefined()
  })

  it("sums billing usage across Turns while keeping the latest active context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-usage-"))
    const store = new MemoryThreadStore()
    const provider = createFauxProvider([
      {
        content: [{ type: "text", text: "first" }],
        usage: { inputTokens: 10, outputTokens: 2, activeContextTokens: 9 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { inputTokens: 4, outputTokens: 1, activeContextTokens: 3 },
      },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id

    for (const text of ["first", "second"]) {
      const admitted = await handlers.admitInput({
        sessionId,
        requestId: `request_${text}`,
        content: {
          kind: "parts" as const,
          parts: [{ type: "text" as const, text: text }],
        },
      })
      if (!admitted.ok) throw new Error(admitted.body.error.message)
      await waitForValue(() =>
        manager.getThread(sessionId)?.status === "idle" ? true : undefined,
      )
    }

    const read = await handlers.readSession({ sessionId })
    if (!read.ok) throw new Error(read.body.error.message)
    expect(read.body.session.usage).toEqual({
      inputTokens: 14,
      outputTokens: 3,
      activeContextTokens: 3,
    })
  })

  it("publishes context window snapshots as durable events before the turn boundary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-tokens-"))
    const store = new MemoryThreadStore()
    const provider = createFauxProvider([
      {
        content: [{ type: "text", text: "answer" }],
        usage: { inputTokens: 10, outputTokens: 2, activeContextTokens: 12 },
      },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const eventHub = createSessionEventHub()
    const handlers = createThreadServerHandlers({ manager, store, eventHub })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const delivered: string[] = []
    const subscription = eventHub.subscribe(sessionId, (delivery) => {
      if (delivery.kind === "durable")
        delivered.push(...delivery.events.map((event) => event.type))
    })
    cleanups.push(async () => subscription.close())

    // A catalog model with a known window: 1_050_000 tokens at 100%.
    const admitted = await handlers.admitInput({
      sessionId,
      requestId: "request_tokens",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "answer" }],
      },
      modelSelection: { provider: "openai", model: "gpt-6-sol" },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await waitForValue(() =>
      manager.getThread(sessionId)?.status === "idle" ? true : undefined,
    )
    await waitForValue(() =>
      delivered.includes("turn.completed") ? true : undefined,
    )

    // The snapshot is its own durable record, delivered ahead of the turn
    // boundary instead of riding turn completion.
    expect(delivered.indexOf("context.tokens")).toBeGreaterThanOrEqual(0)
    expect(delivered.indexOf("context.tokens")).toBeLessThan(
      delivered.indexOf("turn.completed"),
    )

    const events = await handlers.readSessionEvents({ sessionId })
    if (!events.ok) throw new Error(events.body.error.message)
    const snapshots = events.body.events.filter(
      (event) => event.type === "context.tokens",
    )
    expect(snapshots).toEqual([
      expect.objectContaining({
        data: {
          turnId: "request_tokens",
          activeContextTokens: 12,
          capacityTokens: 1_050_000,
          provider: "openai",
          model: "gpt-6-sol",
        },
      }),
    ])
  })

  it.each([
    "truncated",
    "refused",
  ] as const)("delivers %s completion metadata through live events and durable replay", async (reason) => {
    const workspace = await mkdtemp(
      join(tmpdir(), "yakitori-handler-completion-"),
    )
    const store = new MemoryThreadStore()
    const stream: StreamFn = async function* () {
      yield {
        type: "response",
        response: {
          stopReason:
            reason === "truncated"
              ? ModelStopReason.Length
              : ModelStopReason.ContentFilter,
          content: [{ type: "text", text: "Partial answer." }],
          ...(reason === "truncated"
            ? { lengthReason: "output" as const }
            : {}),
        },
      }
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const eventHub = createSessionEventHub()
    const handlers = createThreadServerHandlers({ manager, store, eventHub })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const outcomes: unknown[] = []
    const subscription = eventHub.subscribe(sessionId, (delivery) => {
      if (
        delivery.kind === "transient" &&
        delivery.event.type === "turn.finished"
      )
        outcomes.push(delivery.event.outcome)
    })
    cleanups.push(async () => subscription.close())
    const admitted = await handlers.admitInput({
      sessionId,
      requestId: "request_completion",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "answer" }],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await waitForValue(() => outcomes[0])
    const expected = expect.objectContaining({
      status: "completed",
      reason,
      answerItemIds: expect.any(Array),
    })
    expect(outcomes).toEqual([expected])
    const replay = await handlers.readSessionEvents({ sessionId })
    if (!replay.ok) throw new Error(replay.body.error.message)
    expect(
      replay.body.events.find(
        (event) => isKernelEvent(event) && event.type === "turn.completed",
      ),
    ).toMatchObject({
      data: { outcome: expected },
    })
  })

  it("publishes each rollout event only through its append fence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-fence-"))
    const store = new MemoryThreadStore()
    const provider = createFauxProvider([
      {
        snapshots: ["final answer"],
        content: [
          { type: "reasoning", text: "considering" },
          { type: "text", text: "final answer" },
        ],
      },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const eventHub = createSessionEventHub()
    const handlers = createThreadServerHandlers({ manager, store, eventHub })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })

    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const deliveries: string[] = []
    const subscription = eventHub.subscribe(sessionId, (delivery) => {
      if (delivery.kind === "transient") {
        deliveries.push(delivery.event.type)
        return
      }
      deliveries.push(...delivery.events.map((event) => event.type))
    })
    cleanups.push(async () => subscription.close())

    const originalRead = store.readThread.bind(store)
    const readStarted = deferred<void>()
    const releaseReads = deferred<void>()
    let blockReads = true
    store.readThread = async (threadId) => {
      if (blockReads) {
        readStarted.resolve()
        await releaseReads.promise
      }
      return originalRead(threadId)
    }

    const admitted = handlers.admitInput({
      sessionId,
      requestId: "request_fenced_delivery",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "answer" }],
      },
    })
    await readStarted.promise
    await waitForValue(() =>
      manager.getThread(sessionId)?.status === "idle" ? true : undefined,
    )
    blockReads = false
    releaseReads.resolve()
    const result = await admitted
    if (!result.ok) throw new Error(result.body.error.message)
    await waitForValue(() =>
      deliveries.includes("turn.completed") ? true : undefined,
    )

    expect(deliveries.indexOf("turn.started")).toBeLessThan(
      deliveries.indexOf("assistant.delta"),
    )
    expect(deliveries.indexOf("assistant.delta")).toBeLessThan(
      deliveries.indexOf("item.completed"),
    )
    expect(deliveries.indexOf("item.completed")).toBeLessThan(
      deliveries.indexOf("turn.completed"),
    )

    const replay = await handlers.readSessionEvents({ sessionId })
    if (!replay.ok) throw new Error(replay.body.error.message)
    expect(
      replay.body.events.find(
        (event) => isKernelEvent(event) && event.type === "turn.completed",
      ),
    ).toMatchObject({
      type: "turn.completed",
      data: {
        metrics: { modelCalls: 1, toolCalls: 0 },
      },
    })
    expect(
      replay.body.events.find(
        (event) =>
          isKernelEvent(event) &&
          event.type === "item.completed" &&
          event.data.item.type === "agent_message",
      ),
    ).toMatchObject({
      type: "item.completed",
      data: {
        item: {
          type: "agent_message",
          content: [{ type: "text", text: "final answer" }],
        },
      },
    })
    const restored = await handlers.readSession({ sessionId })
    if (!restored.ok) throw new Error(restored.body.error.message)
    expect(restored.body.session.counts).toMatchObject({ items: 2, tools: 0 })
  })

  it("publishes structured model retry diagnostics as a runtime warning", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-retry-"))
    const store = new MemoryThreadStore()
    let attempt = 0
    const stream: StreamFn = async function* () {
      attempt += 1
      if (attempt === 1) {
        yield {
          type: "failure",
          failure: {
            kind: "server_error",
            stage: "response_headers",
            provider: "faux",
            wireApi: "faux",
            status: 503,
            message: "The model provider encountered a temporary server error.",
          },
        }
        return
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "recovered" }],
        },
      }
    }
    const registry = createProviderRegistry({
      faux: createModelProvider({
        info: {
          id: "faux",
          wireApi: "faux",
          capabilities: { remoteCompaction: false },
          retry: { sleep: async () => {}, random: () => 0 },
        },
        stream,
      }),
    })
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          modelClient: registry.createClient(),
          provider: "faux",
          model: "faux",
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const eventHub = createSessionEventHub()
    const handlers = createThreadServerHandlers({ manager, store, eventHub })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    let warning: unknown
    const subscription = eventHub.subscribe(sessionId, (delivery) => {
      if (
        delivery.kind === "transient" &&
        delivery.event.type === "runtime.warning" &&
        delivery.event.code === "model.retry"
      ) {
        warning = delivery.event
      }
    })
    cleanups.push(async () => subscription.close())

    const admitted = await handlers.admitInput({
      sessionId,
      requestId: "request_retry_warning",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "recover" }],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await waitForValue(() => (warning === undefined ? undefined : true))

    expect(warning).toMatchObject({
      type: "runtime.warning",
      sessionId,
      code: "model.retry",
      details: {
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 8,
        kind: "server_error",
        status: 503,
      },
    })
  })

  it("promotes attachments into the physical rollout asset namespace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-assets-"))
    const store = new MemoryThreadStore()
    const threadId = "session_00000000-0000-4000-8000-000000000001"
    const rolloutId = "rollout_physical"
    const now = new Date().toISOString()
    await store.createThread({
      id: threadId,
      conversationId: threadId,
      createdAt: now,
      updatedAt: now,
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    await store.shutdownThread(threadId)
    store.reidentifyRollout(threadId, rolloutId)
    const rolloutDirectory = join(workspace, "rollouts", rolloutId)
    await mkdir(rolloutDirectory, { recursive: true })
    await writeFile(join(rolloutDirectory, "rollout.jsonl"), "fixture\n")
    const rolloutAssets = createRolloutAssets(workspace, {
      async withMutationLease(candidate, mutate) {
        const owned = (await store.readThread(threadId))?.metadata.rolloutId
        if (owned !== candidate) {
          throw new Error(`Physical rollout ${candidate} is not owned.`)
        }
        return mutate()
      },
    })
    const attachments = await rolloutAssets.importImageBytes(
      rolloutId,
      "draft_physical",
      [{ name: "screen.png", data: pngBytes() }],
    )
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([
            { content: [{ type: "text", text: "done" }] },
          ]).stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      rolloutAssets,
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })

    const invalid = await handlers.admitInput({
      sessionId: threadId,
      requestId: "request_invalid_rollout_asset",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "inspect" },
          {
            type: "image" as const,
            name: "screen.png",
            mediaType: "image/png",
            sizeBytes: 24,
            file: {
              rolloutId: "../escape",
              path: "attachments/staging/draft/1.png",
            },
          },
        ],
      },
    })
    expect(invalid).toMatchObject({
      ok: false,
      status: 400,
      body: { error: { code: "invalid_input" } },
    })

    const admitted = await handlers.admitInput({
      sessionId: threadId,
      requestId: "request_physical_assets",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "inspect" },
          ...attachments.map((image) => ({ type: "image" as const, ...image })),
        ],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await vi.waitFor(async () => {
      const stored = await store.readThread(threadId)
      const image = stored?.rollout.flatMap((record) =>
        record.item.type === "response_item" &&
        record.item.item.item.role === "user"
          ? record.item.item.item.content.filter(
              (block) => block.type === "image",
            )
          : [],
      )[0]
      expect(image).toMatchObject({ file: { rolloutId } })
    }, 10_000)
  })

  it("keeps a rejected prompt's draft image and removes its unused request copy", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-rejected-image-"))
    const store = new MemoryThreadStore()
    const rolloutAssets = createRolloutAssets(workspace, {
      async withMutationLease(_rolloutId, mutate) {
        return mutate()
      },
    })
    const hookRunner: HookRunner = {
      async dispose() {},
      async run(request) {
        return {
          continue: request.event !== HookEvent.UserPromptSubmit,
          additionalContext: [],
        }
      },
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([
            { content: [{ type: "text", text: "unreachable" }] },
          ]).stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
          hookRunner,
        }),
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      rolloutAssets,
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    const rolloutId = (await store.readThread(sessionId))?.metadata.rolloutId
    if (rolloutId === undefined) throw new Error("Missing rollout id.")
    await mkdir(join(workspace, "rollouts", rolloutId), { recursive: true })
    const [draft] = await rolloutAssets.importImageBytes(
      rolloutId,
      "draft_rejected",
      [{ name: "screen.png", data: pngBytes() }],
    )
    if (draft === undefined) throw new Error("Missing draft image.")
    const admitted = await handlers.admitInput({
      sessionId,
      requestId: "request_rejected_image",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "blocked" },
          { type: "image" as const, ...draft },
        ],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await expect
      .poll(async () =>
        (await store.readThread(sessionId))?.rollout.some(
          ({ item }) =>
            item.type === "turn_completed" &&
            item.turnId === "request_rejected_image",
        ),
      )
      .toBe(true)
    await expect(rolloutAssets.read(draft.file)).resolves.toEqual(pngBytes())
    const replayed = await handlers.admitInput({
      sessionId,
      requestId: "request_rejected_image",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "blocked" },
          { type: "image" as const, ...draft },
        ],
      },
    })
    expect(replayed).toMatchObject({ ok: true, status: 200 })
    await expect(rolloutAssets.read(draft.file)).resolves.toEqual(pngBytes())
    await vi.waitFor(async () => {
      await expect(
        rolloutAssets.read({
          rolloutId,
          path: "attachments/requests/request_rejected_image/1.png",
        }),
      ).rejects.toMatchObject({ code: "ENOENT" })
    }, 10_000)
    expect(
      (await store.readThread(sessionId))?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.turnId === "request_rejected_image" &&
          item.item.item.role === "user",
      ),
    ).toBe(false)
  })

  it("returns reusable image references for steering interrupted before sampling", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-steer-assets-"))
    const store = new MemoryThreadStore()
    const started = deferred<void>()
    const release = deferred<void>()
    let calls = 0
    const stream: StreamFn = async function* () {
      calls += 1
      if (calls === 1) {
        started.resolve()
        await release.promise
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
    }
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const rolloutAssets = createRolloutAssets(workspace, {
      async withMutationLease(_rolloutId, mutate) {
        return mutate()
      },
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      rolloutAssets,
    })
    cleanups.push(async () => {
      release.resolve()
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    await mkdir(join(workspace, "rollouts", sessionId), { recursive: true })
    await writeFile(
      join(workspace, "rollouts", sessionId, "rollout.jsonl"),
      "fixture\n",
    )
    const draft = await rolloutAssets.importImageBytes(
      sessionId,
      "draft_steer",
      [{ name: "original.png", data: pngBytes() }],
    )
    const first = await handlers.admitInput({
      sessionId,
      requestId: "request_active",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "first" }],
      },
    })
    if (!first.ok) throw new Error(first.body.error.message)
    await started.promise

    const steered = await handlers.steerInput({
      sessionId,
      requestId: "request_image_steer",
      expectedTurnId: "request_active",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "inspect image" },
          ...draft.map((image) => ({ type: "image" as const, ...image })),
        ],
      },
    })
    if (!steered.ok) throw new Error(steered.body.error.message)
    expect(
      steered.body.content.parts.find((part) => part.type === "image")?.name,
    ).toBe("original.png")
    expect(
      steered.body.content.parts.find((part) => part.type === "image")?.file
        .path,
    ).toContain("attachments/requests/")
    const promoted = steered.body.content.parts.find(
      (part) => part.type === "image",
    )
    if (promoted === undefined) throw new Error("Image was not promoted.")
    expect(await rolloutAssets.read(promoted.file)).toEqual(pngBytes())

    const interrupted = await handlers.cancelTurn({
      sessionId,
      turnId: "request_active",
    })
    if (!interrupted.ok) throw new Error(interrupted.body.error.message)
    release.resolve()
    await waitForValue(() =>
      manager.getThread(sessionId)?.status === "idle" ? true : undefined,
    )
    expect(await rolloutAssets.read(promoted.file)).toEqual(pngBytes())
    const retried = await handlers.queueInput({
      sessionId,
      requestId: "request_recovered_image",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "inspect image" }, promoted],
      },
    })
    if (!retried.ok) throw new Error(retried.body.error.message)
    expect(retried.body.inputId).toMatch(/^input_/)
  })

  it("maps attachment ownership lost to concurrent deletion as not found", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-race-"))
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([]).stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const rolloutAssets = createRolloutAssets(workspace, {
      async withMutationLease(rolloutId) {
        throw createYakitoriError({
          code: YakitoriErrorCode.NotFound,
          message: `Physical rollout ${rolloutId} is not owned by a Thread.`,
          details: { rolloutId },
        })
      },
    })
    const handlers = createThreadServerHandlers({
      manager,
      store,
      rolloutAssets,
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const rolloutId = created.body.session.id

    const admitted = await handlers.admitInput({
      sessionId: rolloutId,
      requestId: "request_deleted_during_promotion",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "inspect" },
          {
            type: "image" as const,
            name: "screen.png",
            mediaType: "image/png",
            sizeBytes: 24,
            file: {
              rolloutId,
              path: "attachments/staging/draft_deleted/1.png",
            },
          },
        ],
      },
    })

    expect(admitted).toMatchObject({
      ok: false,
      status: 404,
      body: { error: { code: "not_found" } },
    })
  })

  it("lists discoverable skills for a session, hiding disabled ones", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-handler-skills-"))
    const skillDirectory = join(workspace, ".agents", "skills", "template")
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: Template Creator\ndescription: Makes templates\n---\nBody.\n",
    )
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([]).stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const skillsLoader = createSkillsLoader()
    const handlers = createThreadServerHandlers({
      manager,
      store,
      listSessionSkills: async ({ workingDirectory }) => {
        const discovered = await skillsLoader({
          workingDirectory,
          homeDir: workspace,
          userHomeDir: workspace,
        })
        return [
          ...discovered.skills,
          {
            name: "Disabled Skill",
            description: "Hidden",
            path: join(skillDirectory, "DISABLED.md"),
            scope: "repo" as const,
            enabled: false,
          },
        ]
      },
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id

    const listed = await handlers.listSkills({ sessionId })

    if (!listed.ok) throw new Error(listed.body.error.message)
    expect(listed.body.skills).toEqual([
      {
        name: "Template Creator",
        description: "Makes templates",
        path: expect.stringContaining("SKILL.md"),
        scope: "repo",
      },
    ])
  })

  it("answers an empty skill list without discovery wired", async () => {
    const store = new MemoryThreadStore()
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: createFauxProvider([]).stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const handlers = createThreadServerHandlers({ manager, store })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
    })
    const created = await handlers.createSession({
      workingDirectory: "/tmp",
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)

    const listed = await handlers.listSkills({
      sessionId: created.body.session.id,
    })
    if (!listed.ok) throw new Error(listed.body.error.message)
    expect(listed.body.skills).toEqual([])

    const missing = await handlers.listSkills({
      sessionId: "session_00000000-0000-0000-0000-000000000000",
    })
    expect(missing).toMatchObject({
      ok: false,
      body: { error: { code: "not_found" } },
    })
  })
})

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
