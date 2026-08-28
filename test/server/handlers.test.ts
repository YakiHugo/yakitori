import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  COMPACT_DIRECTIVE,
  EventType,
  InputRole,
} from "../../src/kernel/events.ts"
import { createSessionId } from "../../src/kernel/ids.ts"
import { createSessionFiles } from "../../src/kernel/session-files.ts"
import { createSessionKernel } from "../../src/kernel/session-kernel.ts"
import {
  createServerHandlers,
  type ServerHandlers,
} from "../../src/server/handlers.ts"
import {
  ApiErrorCode,
  type ApiHandlerResult,
} from "../../src/server/protocol.ts"
import { createMemoryEventStore } from "../kernel/memory-event-store.ts"
import { testTurnExecutionContext } from "../kernel/turn-context.ts"
import { createPermissionGate } from "../../src/runtime/permission-gate.ts"

describe("server handlers", () => {
  it("exposes and resolves only active runtime permissions", async () => {
    const kernel = createSessionKernel(createMemoryEventStore())
    const gate = createPermissionGate()
    const server = createServerHandlers(kernel, {
      listPendingPermissions: (sessionId) => gate.list(sessionId),
      resolvePermission: (input) => gate.resolve(input),
    })
    const created = await server.createSession()
    expectOk(created)
    const pendingOutcome = gate.request({
      sessionId: created.body.session.id,
      turnId: "turn_active",
      toolCallId: "tool_guarded",
      action: "command_execution",
      subject: "pnpm test",
      timeoutMs: 60_000,
    })
    const pending = gate.list(created.body.session.id)[0]
    if (!pending) throw new Error("missing runtime permission")

    const read = await server.readSession({
      sessionId: created.body.session.id,
    })
    expectOk(read)
    expect(read.body.session.pendingPermissions).toEqual([
      expect.objectContaining({
        permissionRequestId: pending.permissionRequestId,
        action: "command_execution",
      }),
    ])
    expect(read.body.session.counts.permissions).toBe(1)

    const resolved = await server.resolvePermission({
      sessionId: created.body.session.id,
      turnId: pending.turnId,
      permissionRequestId: pending.permissionRequestId,
      behavior: "allow",
    })
    expectOk(resolved)
    expect(resolved.body).toEqual({
      sessionId: created.body.session.id,
      turnId: pending.turnId,
      permissionRequestId: pending.permissionRequestId,
      behavior: "allow",
    })
    await expect(pendingOutcome).resolves.toEqual({ kind: "allow" })

    expectError(
      await server.resolvePermission({
        sessionId: created.body.session.id,
        turnId: pending.turnId,
        permissionRequestId: pending.permissionRequestId,
        behavior: "allow",
      }),
      404,
      ApiErrorCode.NotFound,
    )
  })

  it("creates a session with a public detail shape", async () => {
    await withServer(async (server) => {
      const result = await server.createSession({
        title: "Server boundary",
        workingDirectory: "/tmp/yakitori",
        metadata: {
          stage: "api",
        },
      })

      expectOk(result)
      expect(result.status).toBe(201)
      expect(result.body.event).toMatchObject({
        seq: 1,
        type: EventType.SessionCreated,
      })
      expect(result.body.session).toMatchObject({
        id: result.body.event.sessionId,
        seq: 1,
        title: "Server boundary",
        workingDirectory: "/tmp/yakitori",
        metadata: {
          stage: "api",
        },
        counts: {
          inputs: 0,
          pendingInputs: 0,
          turns: 0,
          items: 0,
          permissions: 0,
          tools: 0,
        },
      })
      expect("completedTurns" in result.body.session).toBe(false)
    })
  })

  it("lists sessions with an opaque cursor bound to the request", async () => {
    await withServer(async (server) => {
      const first = await server.createSession({ title: "First" })
      const second = await server.createSession({ title: "Second" })
      expectOk(first)
      expectOk(second)

      const firstPage = await server.listSessions({ limit: 1 })
      expectOk(firstPage)

      expect(firstPage.body.sessions).toHaveLength(1)
      expect(firstPage.body.nextCursor).toEqual(expect.any(String))
      expect(firstPage.body.nextCursor).not.toContain(
        firstPage.body.sessions[0]?.id ?? "",
      )

      const secondPage = await server.listSessions({
        limit: 1,
        cursor: firstPage.body.nextCursor,
      })
      expectOk(secondPage)

      expect(secondPage.body.sessions).toHaveLength(1)
      expect(
        new Set([
          firstPage.body.sessions[0]?.id,
          secondPage.body.sessions[0]?.id,
        ]),
      ).toEqual(new Set([first.body.session.id, second.body.session.id]))

      const mismatchedCursor = await server.listSessions({
        limit: 2,
        cursor: firstPage.body.nextCursor,
      })
      expectError(mismatchedCursor, 400, ApiErrorCode.InvalidCursor)
    })
  })

  it("filters the session list by working directory and binds it to the cursor", async () => {
    await withServer(async (server) => {
      const first = await server.createSession({
        title: "A1",
        workingDirectory: "/project/a",
      })
      const second = await server.createSession({
        title: "B1",
        workingDirectory: "/project/b",
      })
      const third = await server.createSession({
        title: "A2",
        workingDirectory: "/project/a",
      })
      expectOk(first)
      expectOk(second)
      expectOk(third)

      const filtered = await server.listSessions({
        workingDirectory: "/project/a",
      })
      expectOk(filtered)
      expect(
        filtered.body.sessions.map((session) => session.id).sort(),
      ).toEqual([first.body.session.id, third.body.session.id].sort())

      const firstPage = await server.listSessions({
        limit: 1,
        workingDirectory: "/project/a",
      })
      expectOk(firstPage)
      expect(firstPage.body.sessions).toHaveLength(1)
      const secondPage = await server.listSessions({
        limit: 1,
        workingDirectory: "/project/a",
        cursor: firstPage.body.nextCursor,
      })
      expectOk(secondPage)
      expect(
        new Set([
          firstPage.body.sessions[0]?.id,
          secondPage.body.sessions[0]?.id,
        ]),
      ).toEqual(new Set([first.body.session.id, third.body.session.id]))

      expectError(
        await server.listSessions({
          limit: 1,
          workingDirectory: "/project/b",
          cursor: firstPage.body.nextCursor,
        }),
        400,
        ApiErrorCode.InvalidCursor,
      )

      const unfiltered = await server.listSessions({})
      expectOk(unfiltered)
      expect(unfiltered.body.sessions).toHaveLength(3)
    })
  })

  it("returns explicit errors for invalid cursors and missing sessions", async () => {
    await withServer(async (server) => {
      expectError(
        await server.listSessions({ cursor: "not-json" }),
        400,
        ApiErrorCode.InvalidCursor,
      )

      expectError(
        await server.readSession({ sessionId: createSessionId() }),
        404,
        ApiErrorCode.NotFound,
      )
    })
  })

  it("admits input without starting a runtime turn", async () => {
    await withServer(async (server) => {
      const created = await server.createSession()
      expectOk(created)

      const admitted = await server.admitInput({
        sessionId: created.body.session.id,
        requestId: "request_handler-admit",
        content: {
          kind: "text",
          text: "next slice",
        },
      })
      expectOk(admitted)
      expect(admitted.status).toBe(201)
      expect(admitted.body.requestId).toBe("request_handler-admit")
      expect(admitted.body.event).toMatchObject({
        seq: 2,
        type: EventType.InputAdmitted,
        data: {
          inputId: admitted.body.inputId,
        },
      })

      const read = await server.readSession({
        sessionId: created.body.session.id,
      })
      expectOk(read)
      expect(read.body.session.counts).toMatchObject({
        inputs: 1,
        pendingInputs: 1,
        turns: 0,
      })
    })
  })

  it("rejects image admission when Session file storage is unavailable", async () => {
    await withServer(async (server) => {
      const created = await server.createSession()
      expectOk(created)

      const admitted = await server.admitInput({
        sessionId: created.body.session.id,
        requestId: "request_image",
        content: {
          kind: "text",
          text: "inspect",
          attachments: [
            {
              name: "screen.png",
              mediaType: "image/png",
              sizeBytes: 9,
              file: {
                sessionId: created.body.session.id,
                path: "attachments/staging/draft_1/1.png",
              },
            },
          ],
        },
      })

      expectError(admitted, 400, ApiErrorCode.InvalidInput)
    })
  })

  it("admits a batch of reference-backed images", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-handler-images-"))
    try {
      const sessionFiles = createSessionFiles(root)
      const server = createServerHandlers(
        createSessionKernel(createMemoryEventStore()),
        { sessionFiles },
      )
      const created = await server.createSession()
      expectOk(created)
      const image = pngBuffer(4096)
      const attachments = await sessionFiles.importImageBytes(
        created.body.session.id,
        "draft_many_images",
        [image, image, image].map((data, index) => ({
          name: `screen-${String(index + 1)}.png`,
          data,
        })),
      )

      const admitted = await server.admitInput({
        sessionId: created.body.session.id,
        requestId: "request_many_images",
        content: { kind: "text", text: "inspect", attachments },
      })

      expectOk(admitted)
      const event = admitted.body.event
      expect(event.type).toBe(EventType.InputAdmitted)
      if (event.type !== EventType.InputAdmitted) {
        throw new Error("expected input admission")
      }
      expect(event.data.content).toMatchObject({
        kind: "text",
        attachments: expect.arrayContaining([
          expect.objectContaining({ name: "screen-3.png" }),
        ]),
      })
      if (event.data.content.kind !== "text") {
        throw new Error("expected text content")
      }
      expect(event.data.content.attachments).toHaveLength(3)

      const replayed = await server.admitInput({
        sessionId: created.body.session.id,
        requestId: "request_many_images",
        content: { kind: "text", text: "inspect", attachments },
      })
      expectOk(replayed)
      expect(replayed.status).toBe(200)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("admits the compact directive as a runtime-role input", async () => {
    await withServer(async (server) => {
      expectError(
        await server.compactSession({ sessionId: createSessionId() }),
        404,
        ApiErrorCode.NotFound,
      )

      const created = await server.createSession()
      expectOk(created)
      const compacted = await server.compactSession({
        sessionId: created.body.session.id,
      })
      expectOk(compacted)
      expect(compacted.status).toBe(201)
      expect(compacted.body.event).toMatchObject({
        type: EventType.InputAdmitted,
        data: {
          role: InputRole.Runtime,
          content: { kind: "text", text: COMPACT_DIRECTIVE },
        },
      })
    })
  })

  it("replays the compact admission for a repeated requestId", async () => {
    await withServer(async (server) => {
      const created = await server.createSession()
      expectOk(created)
      const first = await server.compactSession({
        sessionId: created.body.session.id,
        requestId: "request_compact_1",
      })
      expectOk(first)
      expect(first.status).toBe(201)

      const replay = await server.compactSession({
        sessionId: created.body.session.id,
        requestId: "request_compact_1",
      })
      expectOk(replay)
      expect(replay.status).toBe(200)
      expect(replay.body.requestId).toBe("request_compact_1")
      expect(replay.body.inputId).toBe(first.body.inputId)
    })
  })

  it("rejects input text above the configured model-visible cap", async () => {
    const server = createServerHandlers(
      createSessionKernel(createMemoryEventStore()),
      { maxInputBytes: 4 },
    )
    const created = await server.createSession()
    expectOk(created)

    expectError(
      await server.admitInput({
        sessionId: created.body.session.id,
        requestId: "request_oversized",
        content: { kind: "text", text: "12345" },
      }),
      400,
      ApiErrorCode.InvalidInput,
    )
  })

  it("validates and records the provider selected for the next Turn", async () => {
    const server = createServerHandlers(
      createSessionKernel(createMemoryEventStore()),
      { availableProviders: ["openai"] },
    )
    const created = await server.createSession()
    expectOk(created)

    const rejected = await server.admitInput({
      sessionId: created.body.session.id,
      requestId: "request_unknown-provider",
      content: { kind: "text", text: "use another model" },
      modelSelection: { provider: "anthropic", model: "claude-test" },
    })
    expectError(rejected, 400, ApiErrorCode.InvalidInput)

    const admitted = await server.admitInput({
      sessionId: created.body.session.id,
      requestId: "request_selected-provider",
      content: { kind: "text", text: "use this model" },
      modelSelection: {
        provider: "openai",
        model: "gpt-5.6-sol",
        effort: "high",
        speed: "fast",
      },
    })
    expectOk(admitted)
    expect(admitted.body.event).toMatchObject({
      type: EventType.InputAdmitted,
      data: {
        modelSelection: {
          provider: "openai",
          model: "gpt-5.6-sol",
          effort: "high",
          speed: "fast",
        },
      },
    })
    const read = await server.readSession({
      sessionId: created.body.session.id,
    })
    expectOk(read)
    expect(read.body.session.currentModel).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "high",
      speed: "fast",
    })

    const queued = await server.admitInput({
      sessionId: created.body.session.id,
      requestId: "request_second-queued",
      content: { kind: "text", text: "run later" },
      modelSelection: {
        provider: "openai",
        model: "gpt-5.6-sol",
        effort: "low",
      },
    })
    expectOk(queued)
    const queuedRead = await server.readSession({
      sessionId: created.body.session.id,
    })
    expectOk(queuedRead)
    expect(queuedRead.body.session.currentModel).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "high",
      speed: "fast",
    })

    const badSpeed = await server.admitInput({
      sessionId: created.body.session.id,
      requestId: "request_bad-speed",
      content: { kind: "text", text: "use this model" },
      modelSelection: { provider: "openai", model: "gpt-5.6-sol", speed: "" },
    })
    expectError(badSpeed, 400, ApiErrorCode.InvalidInput)
  })

  it("returns the original admission for an exact request retry", async () => {
    await withServer(async (server) => {
      const created = await server.createSession()
      expectOk(created)
      const request = {
        sessionId: created.body.session.id,
        requestId: "request_handler-retry",
        content: {
          kind: "text",
          text: "admit exactly once",
        },
      }

      const first = await server.admitInput(request)
      const replayed = await server.admitInput(request)
      expectOk(first)
      expectOk(replayed)

      expect(first.status).toBe(201)
      expect(replayed.status).toBe(200)
      expect(replayed.body).toEqual(first.body)
      expectError(
        await server.admitInput({
          ...request,
          content: {
            kind: "text",
            text: "changed admission",
          },
        }),
        409,
        ApiErrorCode.Conflict,
      )
      expectError(
        await server.admitInput({
          ...request,
          modelSelection: { provider: "openai", model: "gpt-5.6-sol" },
        }),
        409,
        ApiErrorCode.Conflict,
      )
      expectError(
        await server.admitInput({
          sessionId: created.body.session.id,
          content: request.content,
        }),
        400,
        ApiErrorCode.InvalidInput,
      )

      const read = await server.readSession({
        sessionId: created.body.session.id,
      })
      expectOk(read)
      expect(read.body.session.counts.inputs).toBe(1)
      expect(read.body.session.seq).toBe(2)
    })
  })

  it("reads durable session events after a sequence", async () => {
    await withServer(async (server) => {
      const created = await server.createSession()
      expectOk(created)
      const admitted = await server.admitInput({
        sessionId: created.body.session.id,
        requestId: "request_handler-events",
        content: {
          kind: "text",
          text: "show events",
        },
      })
      expectOk(admitted)

      const events = await server.readSessionEvents({
        sessionId: created.body.session.id,
        after: "1",
      })
      expectOk(events)

      expect(events.body.events).toEqual([admitted.body.event])
    })
  })

  it("deletes an idle session and maps busy or missing sessions to errors", async () => {
    const kernel = createSessionKernel(createMemoryEventStore())
    const server = createServerHandlers(kernel)

    expectError(
      await server.deleteSession({ sessionId: "session_bad" }),
      400,
      ApiErrorCode.InvalidInput,
    )
    expectError(
      await server.deleteSession({ sessionId: createSessionId() }),
      404,
      ApiErrorCode.NotFound,
    )

    const busy = await server.createSession()
    expectOk(busy)
    const admitted = await server.admitInput({
      sessionId: busy.body.session.id,
      requestId: "request_handler-delete",
      content: { kind: "text", text: "keep me busy" },
    })
    expectOk(admitted)
    await kernel.startTurn({
      sessionId: busy.body.session.id,
      inputId: admitted.body.inputId,
      executionContext: testTurnExecutionContext(),
    })
    expectError(
      await server.deleteSession({ sessionId: busy.body.session.id }),
      409,
      ApiErrorCode.Conflict,
    )

    const idle = await server.createSession()
    expectOk(idle)
    const deleted = await server.deleteSession({
      sessionId: idle.body.session.id,
    })
    expectOk(deleted)
    expect(deleted.status).toBe(200)
    expect(deleted.body).toEqual({ sessionId: idle.body.session.id })
    expectError(
      await server.readSession({ sessionId: idle.body.session.id }),
      404,
      ApiErrorCode.NotFound,
    )
  })
})

async function withServer(
  run: (server: ServerHandlers) => Promise<void>,
): Promise<void> {
  await run(createServerHandlers(createSessionKernel(createMemoryEventStore())))
}

function expectOk<T>(
  result: ApiHandlerResult<T>,
): asserts result is Extract<ApiHandlerResult<T>, { readonly ok: true }> {
  if (!result.ok) throw new Error(`Expected success: ${result.body.error.code}`)
}

function expectError<T>(
  result: ApiHandlerResult<T>,
  status: number,
  code: ApiErrorCode,
): asserts result is Extract<ApiHandlerResult<T>, { readonly ok: false }> {
  if (result.ok) throw new Error("Expected error response.")
  expect(result.status).toBe(status)
  expect(result.body.error.code).toBe(code)
}

function pngBuffer(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}
