import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ThreadManager } from "../../../src/core/thread-manager.ts"
import { EventType } from "../../../src/kernel/events.ts"
import { createSessionId } from "../../../src/kernel/ids.ts"
import { createPermissionGate } from "../../../src/runtime/permission-gate.ts"
import { SessionConfiguration } from "../../../src/runtime/session-configuration.ts"
import {
  createSessionEventHub,
  type SessionEventHub,
} from "../../../src/server/event-hub.ts"
import {
  createThreadServerHandlers,
  type ThreadServerHandlers,
} from "../../../src/server/handlers.ts"
import type {
  ApiCreateSessionResponse,
  ApiForkSessionResponse,
  ApiListProjectsResponse,
  ApiListProvidersResponse,
  ApiListSessionsResponse,
  ApiProject,
  ApiReadSessionResponse,
} from "../../../src/server/protocol.ts"
import { MessageProcessor } from "../../../src/server/rpc/message-processor.ts"
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  type JsonRpcErrorResponse,
  type JsonRpcResponse,
} from "../../../src/server/rpc/messages.ts"
import {
  createSqliteProjectStore,
  type ProjectStore,
  type SqliteProjectStore,
} from "../../../src/server/sqlite-project-store.ts"
import { createUserConfigStore } from "../../../src/server/user-config.ts"
import { MemoryThreadStore } from "../../core/memory-thread-store.ts"
import {
  initializeConnection,
  openTestConnection,
  type TestConnection,
} from "./testkit.ts"

// RPC-level integration coverage over the real ServerHandlers: the HTTP
// routes that used to exercise these contracts are gone, so the method
// surface is now the boundary these tests pin.

function createRealHandlers(
  eventHub: SessionEventHub,
  permissionGate = createPermissionGate({
    publish: (event) => eventHub.publishTransient(event),
  }),
  projectStore?: ProjectStore,
): ThreadServerHandlers {
  const store = new MemoryThreadStore()
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => ({
      prepare(_snapshot, input) {
        const selection = { provider: "faux", model: "scripted" }
        return {
          turnId: input.submissionId,
          selection,
          configuration: SessionConfiguration.create({
            selection,
            workspaceRoot: process.cwd(),
            enabledTools: [],
            approvalPolicy: "always_approve",
            promptCacheKey: input.submissionId,
          }).snapshot,
        }
      },
      start() {
        return { completion: Promise.resolve(), abort() {} }
      },
    }),
  })
  return createThreadServerHandlers({
    manager,
    store,
    sessionDefaults: {
      workingDirectory: process.cwd(),
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    },
    eventHub,
    resolvePermission: (input) => permissionGate.resolve(input),
    listPendingPermissions: (sessionId) => permissionGate.list(sessionId),
    ...(projectStore === undefined ? {} : { projectStore }),
  })
}

function realSetup(
  options: Omit<
    ConstructorParameters<typeof MessageProcessor>[0],
    "handlers" | "eventHub"
  > = {},
): {
  processor: MessageProcessor
  connection: TestConnection
  eventHub: SessionEventHub
  handlers: ThreadServerHandlers
} {
  const eventHub = createSessionEventHub()
  const handlers = createRealHandlers(eventHub, undefined, options.projectStore)
  const processor = new MessageProcessor({ handlers, eventHub, ...options })
  const connection = openTestConnection(processor)
  return { processor, connection, eventHub, handlers }
}

async function rpc<T>(
  connection: TestConnection,
  method: string,
  params?: unknown,
): Promise<T> {
  const response = await connection.sendRequest(method, params)
  expect(response).toHaveProperty("result")
  return (response as JsonRpcResponse).result as T
}

async function rpcError(
  connection: TestConnection,
  method: string,
  params?: unknown,
): Promise<JsonRpcErrorResponse["error"]> {
  const response = await connection.sendRequest(method, params)
  expect(response).toHaveProperty("error")
  return (response as JsonRpcErrorResponse).error
}

async function createSession(
  connection: TestConnection,
  input: Record<string, unknown> = {},
): Promise<ApiCreateSessionResponse> {
  return rpc<ApiCreateSessionResponse>(connection, "session/create", input)
}

describe("session methods over real handlers", () => {
  it("creates and lists sessions", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)

    const created = await createSession(connection, { title: "RPC slice" })
    expect(created.session).toMatchObject({
      id: created.event.sessionId,
      title: "RPC slice",
    })

    const listed = await rpc<ApiListSessionsResponse>(
      connection,
      "session/list",
      { limit: 10 },
    )
    expect(listed.sessions).toEqual([
      expect.objectContaining({ id: created.session.id, title: "RPC slice" }),
    ])
  })

  it("deletes sessions and maps handler errors to RPC error data", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)
    const created = await createSession(connection)
    const sessionId = created.session.id

    expect(await rpc(connection, "session/delete", { sessionId })).toEqual({
      sessionId,
    })

    expect(
      await rpcError(connection, "session/read", { sessionId }),
    ).toMatchObject({
      code: INTERNAL_ERROR,
      data: { code: "not_found" },
    })
    expect(
      await rpcError(connection, "session/delete", {
        sessionId: "session_bad",
      }),
    ).toMatchObject({
      code: INVALID_PARAMS,
      data: { code: "invalid_input" },
    })
    expect(
      await rpcError(connection, "session/delete", {
        sessionId: createSessionId(),
      }),
    ).toMatchObject({
      code: INTERNAL_ERROR,
      data: { code: "not_found" },
    })
  })

  it("validates fork semantics and forks a pure undo", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)
    const created = await createSession(connection, { title: "Fork route" })
    const sessionId = created.session.id
    const admitted = await rpc<{ requestId: string; inputId: string }>(
      connection,
      "session/input",
      {
        sessionId,
        requestId: "request_rpc_fork",
        content: { kind: "text", text: "undo this" },
      },
    )

    for (const invalid of [
      { atInputId: admitted.inputId, reason: "redo" },
      { atInputId: admitted.inputId, reason: "edit" },
      {
        atInputId: admitted.inputId,
        reason: "undo",
        content: { kind: "text", text: "not allowed" },
      },
      {
        atInputId: admitted.inputId,
        reason: "undo",
        modelSelection: { provider: "openai", model: "gpt-test" },
      },
    ]) {
      const error = await rpcError(connection, "session/fork", {
        sessionId,
        ...invalid,
      })
      expect(error).toMatchObject({
        code: INVALID_PARAMS,
        data: { code: "invalid_input" },
      })
    }

    const forked = await rpc<ApiForkSessionResponse>(
      connection,
      "session/fork",
      { sessionId, atInputId: admitted.inputId, reason: "undo" },
    )
    expect(forked.session).toMatchObject({
      parentSessionId: sessionId,
      forkedFromInputId: admitted.inputId,
      forkReason: "undo",
      title: "Fork route",
      counts: { inputs: 0, pendingInputs: 0, turns: 0 },
    })
    expect(forked.events).toEqual([
      expect.objectContaining({
        sessionId: forked.session.id,
        type: EventType.SessionCreated,
      }),
    ])

    const source = await rpc<ApiReadSessionResponse>(
      connection,
      "session/read",
      { sessionId },
    )
    expect(source.session.counts).toMatchObject({
      inputs: 1,
      pendingInputs: 0,
      turns: 1,
    })
  })

  it("rejects a malformed parent session id", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)

    const error = await rpcError(connection, "session/create", {
      parentSessionId: "session_bad",
    })
    expect(error).toMatchObject({
      code: INVALID_PARAMS,
      data: { code: "invalid_input" },
    })
  })

  it("deduplicates retried admissions", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)
    const created = await createSession(connection)
    const sessionId = created.session.id
    const request = {
      sessionId,
      requestId: "request_rpc-retry",
      content: { kind: "text", text: "persist once" },
    }

    const first = await rpc(connection, "session/input", request)
    const replayed = await rpc(connection, "session/input", request)
    expect(replayed).toEqual(first)

    const conflict = await rpcError(connection, "session/input", {
      ...request,
      content: { kind: "text", text: "persist something else" },
    })
    expect(conflict).toMatchObject({
      code: INTERNAL_ERROR,
      data: { code: "conflict" },
    })

    const read = await rpc<ApiReadSessionResponse>(connection, "session/read", {
      sessionId,
    })
    expect(read.session.seq).toBe(5)
    expect(read.session.counts.inputs).toBe(1)
  })

  it("rejects input cancellation once the Turn has started", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)
    const created = await createSession(connection)
    const sessionId = created.session.id
    const admitted = await rpc<{ inputId: string }>(
      connection,
      "session/input",
      {
        sessionId,
        requestId: "request_rpc-cancel-input",
        content: { kind: "text", text: "cancel me" },
      },
    )

    for (const params of [
      { sessionId, inputId: admitted.inputId, reason: "user_cancel" },
      { sessionId, inputId: admitted.inputId },
    ]) {
      const error = await rpcError(connection, "session/input/cancel", params)
      expect(error).toMatchObject({
        code: INTERNAL_ERROR,
        data: { code: "conflict" },
      })
    }

    const malformed = await rpcError(connection, "session/input/cancel", {
      sessionId,
      inputId: "input_bad",
    })
    expect(malformed).toMatchObject({
      code: INVALID_PARAMS,
      data: { code: "invalid_input" },
    })

    const oversized = await rpcError(connection, "session/input/cancel", {
      sessionId,
      inputId: admitted.inputId,
      reason: "x".repeat(513),
    })
    expect(oversized).toMatchObject({
      code: INVALID_PARAMS,
      data: { code: "invalid_input" },
    })
  })

  it("bounds the cancel-turn reason like the cancel-input reason", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)
    const created = await createSession(connection)
    const sessionId = created.session.id

    for (const reason of ["x".repeat(513), 42]) {
      const error = await rpcError(connection, "session/turn/cancel", {
        sessionId,
        turnId: "turn_test",
        reason,
      })
      expect(error).toMatchObject({
        code: INVALID_PARAMS,
        data: { code: "invalid_input" },
      })
    }
  })

  it("streams durable events published after the replay watermark", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)
    const created = await createSession(connection)
    const sessionId = created.session.id

    await rpc(connection, "session/subscribe", { sessionId, after: 1 })
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )

    await rpc(connection, "session/input", {
      sessionId,
      requestId: "request_rpc-stream",
      content: { kind: "text", text: "tail this" },
    })
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        frame.method === "session/event" &&
        (frame.params as { seq: number }).seq === 2,
    )

    const notification = connection
      .notifications("session/event")
      .map((frame) => frame.params)[0] as {
      sessionId: string
      seq: number
      event: { type: string; data: { content: { text: string } } }
    }
    expect(notification).toMatchObject({
      sessionId,
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: { content: { kind: "text", text: "tail this" } },
      },
    })
  })

  it("replays durable events after the subscribe cursor", async () => {
    const { connection } = realSetup()
    await initializeConnection(connection)
    const created = await createSession(connection)
    const sessionId = created.session.id
    for (const requestId of ["request_rpc-resume-1", "request_rpc-resume-2"]) {
      await rpc(connection, "session/input", {
        sessionId,
        requestId,
        content: { kind: "text", text: requestId },
      })
    }
    const snapshot = await rpc<ApiReadSessionResponse>(
      connection,
      "session/read",
      { sessionId },
    )

    await rpc(connection, "session/subscribe", { sessionId, after: 2 })
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )

    const replayed = connection
      .notifications("session/event")
      .map((frame) => (frame.params as { seq: number }).seq)
    // Every durable event after the cursor up to the snapshot watermark, in
    // order, and nothing at or below the cursor.
    expect(replayed.length).toBeGreaterThan(0)
    expect(replayed).toEqual(
      Array.from({ length: replayed.length }, (_, index) => index + 3),
    )
    expect(replayed.at(-1)).toBe(snapshot.session.seq)
  })
})

describe("project methods over a real store", () => {
  function projectSetup(): {
    processor: MessageProcessor
    connection: TestConnection
    projectStore: SqliteProjectStore
  } {
    const projectStore = createSqliteProjectStore({ databasePath: ":memory:" })
    const { processor, connection } = realSetup({ projectStore })
    return { processor, connection, projectStore }
  }

  it("runs the project lifecycle and broadcasts project/changed", async () => {
    const { processor, connection, projectStore } = projectSetup()
    try {
      await initializeConnection(connection)
      const observer = openTestConnection(processor)
      await initializeConnection(observer)

      const created = await rpc<{ project: ApiProject }>(
        connection,
        "project/create",
        { roots: ["/work/alpha"] },
      )
      expect(created.project).toMatchObject({
        name: "alpha",
        roots: ["/work/alpha"],
        metadata: {},
        position: 0,
      })
      expect(created.project.id).toMatch(/^project_/)
      // The broadcast lands after the create response and reaches every
      // initialized connection.
      await observer.waitForFrame(
        (frame) => "method" in frame && frame.method === "project/changed",
      )
      expect(
        observer.notifications("project/changed").map((frame) => frame.params),
      ).toEqual([{ projectId: created.project.id, changeType: "created" }])

      expect(
        await rpc(connection, "project/read", {
          projectId: created.project.id,
        }),
      ).toEqual(created)

      // A no-op update returns the project but suppresses the notification.
      const noop = await rpc<{ project: ApiProject }>(
        connection,
        "project/update",
        { projectId: created.project.id, name: "alpha" },
      )
      expect(noop.project).toEqual(created.project)
      // A real update notifies.
      await rpc(connection, "project/update", {
        projectId: created.project.id,
        name: "renamed",
        metadata: { tier: "one" },
      })

      const second = await rpc<{ project: ApiProject }>(
        connection,
        "project/create",
        { name: "second", roots: ["/work/beta"] },
      )
      await rpc(connection, "project/move", {
        projectId: second.project.id,
        toPosition: 0,
      })
      await rpc(connection, "project/delete", { projectId: second.project.id })

      expect(
        observer.notifications("project/changed").map((frame) => frame.params),
      ).toEqual([
        { projectId: created.project.id, changeType: "created" },
        { projectId: created.project.id, changeType: "updated" },
        { projectId: second.project.id, changeType: "created" },
        { projectId: second.project.id, changeType: "updated" },
        { projectId: second.project.id, changeType: "deleted" },
      ])

      const listed = await rpc<ApiListProjectsResponse>(
        connection,
        "project/list",
        {},
      )
      expect(listed.projects.map((project) => project.name)).toEqual([
        "renamed",
      ])

      const missing = await rpcError(connection, "project/read", {
        projectId: second.project.id,
      })
      expect(missing).toMatchObject({
        code: INTERNAL_ERROR,
        data: { code: "not_found" },
      })
    } finally {
      projectStore.close()
    }
  })

  it("paginates project/list and rejects malformed cursors", async () => {
    const { connection, projectStore } = projectSetup()
    try {
      await initializeConnection(connection)
      for (const name of ["a", "b", "c"]) {
        await rpc(connection, "project/create", {
          name,
          roots: [`/work/${name}`],
        })
      }

      const first = await rpc<ApiListProjectsResponse>(
        connection,
        "project/list",
        { limit: 2 },
      )
      expect(first.projects.map((project) => project.name)).toEqual(["a", "b"])
      expect(first.nextCursor).toBeDefined()

      const second = await rpc<ApiListProjectsResponse>(
        connection,
        "project/list",
        { limit: 2, cursor: first.nextCursor },
      )
      expect(second.projects.map((project) => project.name)).toEqual(["c"])
      expect(second.nextCursor).toBeUndefined()

      const badCursor = await rpcError(connection, "project/list", {
        cursor: "not-a-cursor",
      })
      expect(badCursor).toMatchObject({
        code: INVALID_PARAMS,
        data: { code: "invalid_cursor" },
      })
    } finally {
      projectStore.close()
    }
  })

  it("replays idempotent creates and reports keys of deleted projects", async () => {
    const { processor, connection, projectStore } = projectSetup()
    try {
      await initializeConnection(connection)
      const observer = openTestConnection(processor)
      await initializeConnection(observer)

      const created = await rpc<{ project: ApiProject }>(
        connection,
        "project/create",
        { roots: ["/work/alpha"], idempotencyKey: "gui-add-1" },
      )
      const replayed = await rpc<{ project: ApiProject }>(
        connection,
        "project/create",
        { roots: ["/work/other"], idempotencyKey: "gui-add-1" },
      )
      expect(replayed.project).toEqual(created.project)
      // An idempotent replay is not a creation: no second notification.
      expect(observer.notifications("project/changed")).toHaveLength(1)

      await rpc(connection, "project/delete", {
        projectId: created.project.id,
      })
      const error = await rpcError(connection, "project/create", {
        roots: ["/work/alpha"],
        idempotencyKey: "gui-add-1",
      })
      expect(error).toMatchObject({
        code: INTERNAL_ERROR,
        data: { code: "conflict" },
      })
      expect(error.message).toContain(
        "idempotency key refers to deleted project",
      )
    } finally {
      projectStore.close()
    }
  })

  it("validates roots and names at the boundary", async () => {
    const { connection, projectStore } = projectSetup()
    try {
      await initializeConnection(connection)
      for (const params of [
        {},
        { roots: [] },
        { roots: ["relative/path"] },
        { roots: ["/work/a", "/work/a"] },
        { name: "   ", roots: ["/work/a"] },
      ]) {
        const error = await rpcError(connection, "project/create", params)
        expect(error).toMatchObject({
          code: INVALID_PARAMS,
          data: { code: "invalid_input" },
        })
      }
      // Distinct paths that resolve to the same directory are duplicates.
      const rootDir = await mkdtemp(join(tmpdir(), "yakitori-rpc-projects-"))
      try {
        const linked = join(rootDir, "linked")
        await mkdir(join(rootDir, "real"))
        await symlink(join(rootDir, "real"), linked)
        const error = await rpcError(connection, "project/create", {
          roots: [join(rootDir, "real"), linked],
        })
        expect(error).toMatchObject({
          code: INVALID_PARAMS,
          data: { code: "invalid_input" },
        })
        expect(error.message).toContain("Duplicate resolved project root")
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    } finally {
      projectStore.close()
    }
  })

  it("links sessions to projects with orphan-on-delete reads", async () => {
    const { connection, projectStore } = projectSetup()
    try {
      await initializeConnection(connection)
      const created = await rpc<{ project: ApiProject }>(
        connection,
        "project/create",
        { roots: ["/work/alpha"] },
      )
      const projectId = created.project.id

      const session = await createSession(connection, { projectId })
      expect(session.session.projectId).toBe(projectId)
      expect(session.event).toMatchObject({
        type: "session.created",
        data: { projectId },
      })

      const unknown = await rpcError(connection, "session/create", {
        projectId: "project_00000000-0000-0000-0000-000000000000",
      })
      expect(unknown).toMatchObject({
        code: INVALID_PARAMS,
        data: { code: "invalid_input" },
      })

      const filtered = await rpc<ApiListSessionsResponse>(
        connection,
        "session/list",
        { projectId },
      )
      expect(filtered.sessions.map((entry) => entry.id)).toEqual([
        session.session.id,
      ])

      const other = await rpc<{ project: ApiProject }>(
        connection,
        "project/create",
        { roots: ["/work/beta"] },
      )
      const empty = await rpc<ApiListSessionsResponse>(
        connection,
        "session/list",
        { projectId: other.project.id },
      )
      expect(empty.sessions).toEqual([])

      // Orphan-on-delete: the append-only rollout keeps the stored projectId,
      // but the read path treats it as no project.
      await rpc(connection, "project/delete", { projectId })
      const read = await rpc<ApiReadSessionResponse>(
        connection,
        "session/read",
        { sessionId: session.session.id },
      )
      expect(read.session.projectId).toBeUndefined()
      const unfiltered = await rpc<ApiListSessionsResponse>(
        connection,
        "session/list",
        {},
      )
      expect(unfiltered.sessions).toEqual([
        expect.objectContaining({ id: session.session.id }),
      ])
      expect(unfiltered.sessions[0]?.projectId).toBeUndefined()
      const orphanedFilter = await rpc<ApiListSessionsResponse>(
        connection,
        "session/list",
        { projectId },
      )
      expect(orphanedFilter.sessions).toEqual([])
    } finally {
      projectStore.close()
    }
  })
})

describe("provider and config methods", () => {
  it("serves provider/list from the configured catalog", async () => {
    const providers: ApiListProvidersResponse = {
      providers: [
        {
          name: "faux",
          defaultModel: "scripted",
          models: [
            {
              id: "scripted",
              displayName: "scripted",
              instructionProfileId: "default",
            },
          ],
        },
      ],
      defaultProvider: "faux",
      defaultModel: "scripted",
    }
    const { connection } = realSetup({ providers: async () => providers })
    await initializeConnection(connection)

    expect(await rpc(connection, "provider/list", {})).toEqual(providers)
  })

  it("reports an unexpected catalog failure and answers INTERNAL_ERROR", async () => {
    const cause = new Error("catalog unavailable")
    const failures: unknown[] = []
    const { connection } = realSetup({
      providers: async () => Promise.reject(cause),
      reportOperationalFailure: (failure) => {
        failures.push(failure)
      },
    })
    await initializeConnection(connection)

    const error = await rpcError(connection, "provider/list", {})
    expect(error).toMatchObject({
      code: INTERNAL_ERROR,
      data: { code: "internal_error" },
    })
    expect(failures).toEqual([
      {
        component: "message-processor",
        operation: "provider/list",
        cause,
      },
    ])
  })

  it("validates and persists userPreference/write", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-rpc-config-"))
    try {
      const userConfig = createUserConfigStore({
        configPath: join(rootDir, "config.toml"),
      })
      const { connection } = realSetup({
        userConfig,
        availableProviders: ["anthropic", "faux"],
      })
      await initializeConnection(connection)

      for (const invalid of [
        { provider: "", model: "claude-custom" },
        { provider: "anthropic", model: "" },
        { provider: "anthropic", model: "claude-custom", effort: " " },
        { provider: "missing", model: "arbitrary-slug" },
      ]) {
        const error = await rpcError(
          connection,
          "userPreference/write",
          invalid,
        )
        expect(error).toMatchObject({
          code: INVALID_PARAMS,
          data: { code: "invalid_input" },
        })
      }

      const accepted = await rpc<{
        userPreference: { provider: string; model: string; effort?: string }
      }>(connection, "userPreference/write", {
        provider: "anthropic",
        model: "unknown-but-valid-slug",
        effort: "high",
      })
      expect(accepted).toEqual({
        userPreference: {
          provider: "anthropic",
          model: "unknown-but-valid-slug",
          effort: "high",
        },
      })
      await expect(userConfig.read()).resolves.toEqual(accepted.userPreference)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

describe("permission requests over real handlers", () => {
  it("answers a runtime permission over the RPC answer channel", async () => {
    const eventHub = createSessionEventHub()
    const gate = createPermissionGate({
      publish: (event) => eventHub.publishTransient(event),
    })
    const handlers = createRealHandlers(eventHub, gate)
    const processor = new MessageProcessor({ handlers, eventHub })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    const created = await createSession(connection)
    const sessionId = created.session.id

    await rpc(connection, "session/subscribe", { sessionId })
    await connection.waitForFrame(
      (frame) => "method" in frame && frame.method === "session/replayComplete",
    )

    // The runtime waits on the gate; its request publication flows to the
    // subscribed connection as a transient plus a server→client request.
    const outcomePromise = gate.request({
      sessionId,
      turnId: "turn_1",
      toolCallId: "call_1",
      action: "run_command",
      timeoutMs: 30_000,
    })
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        "id" in frame &&
        frame.method === "session/permission/request",
    )
    const request = connection.frames.find(
      (frame) =>
        "method" in frame &&
        "id" in frame &&
        frame.method === "session/permission/request",
    ) as unknown as {
      id: string | number
      params: { permissionRequestId: string }
    }
    const permissionRequestId = request.params.permissionRequestId

    connection.sendRaw(
      JSON.stringify({
        id: request.id,
        result: { behavior: "allow", reason: { kind: "user_allowed" } },
      }),
    )

    await expect(outcomePromise).resolves.toMatchObject({ kind: "allow" })
    // Confirmation arrives through the event stream, not the answer channel.
    await connection.waitForFrame(
      (frame) =>
        "method" in frame &&
        frame.method === "session/transient" &&
        (frame.params as { type: string }).type === "permission.resolved",
    )
    const resolved = connection
      .notifications("session/transient")
      .map((frame) => frame.params)
      .find(
        (params) => (params as { type: string }).type === "permission.resolved",
      )
    expect(resolved).toMatchObject({
      type: "permission.resolved",
      permissionRequestId,
      outcome: "allow",
    })
  })
})
