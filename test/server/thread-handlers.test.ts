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
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import { createModelProvider } from "../../src/runtime/model-provider.ts"
import { createProviderRegistry } from "../../src/runtime/provider-registry.ts"
import { createSkillsLoader } from "../../src/runtime/skills.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import { createSessionEventHub } from "../../src/server/event-hub.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
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
      content: { kind: "text", text: "nothing to steer" },
    })
    expect(idle.ok).toBe(false)
    if (!idle.ok) expect(idle.body.error.message).toContain("no_active_turn")

    const admitted = await handlers.admitInput({
      sessionId,
      requestId: "request_first",
      content: { kind: "text", text: "start the work" },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await waitForValue(() => (requests.length === 1 ? true : undefined))

    const wrongTurn = await handlers.steerInput({
      sessionId,
      requestId: "request_wrong_turn",
      expectedTurnId: "turn_other",
      content: { kind: "text", text: "wrong target" },
    })
    expect(wrongTurn.ok).toBe(false)
    if (!wrongTurn.ok)
      expect(wrongTurn.body.error.message).toContain("turn_mismatch")

    const steered = await handlers.steerInput({
      sessionId,
      requestId: "request_steer",
      expectedTurnId: "request_first",
      content: { kind: "text", text: "also handle this" },
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
        content: { kind: "text", text: "also handle this" },
      },
    })
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
      content: { kind: "text", text: "A needle in user text" },
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
        content: { kind: "text", text },
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
      content: { kind: "text", text: "answer" },
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
      content: { kind: "text", text: "recover" },
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
        kind: "text",
        text: "inspect",
        attachments: [
          {
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
      content: { kind: "text", text: "inspect", attachments },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    const stored = await store.readThread(threadId)
    const image = stored?.rollout.flatMap((record) =>
      record.item.type === "response_item" &&
      record.item.item.item.role === "user"
        ? (record.item.item.item.images ?? [])
        : [],
    )[0]

    expect(image).toMatchObject({ file: { rolloutId } })
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
        kind: "text",
        text: "inspect",
        attachments: [
          {
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
