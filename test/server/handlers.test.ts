import { describe, expect, it } from "vitest"
import {
  ApiErrorCode,
  type ApiHandlerResult,
  createServerHandlers,
  createSessionId,
  createSessionKernel,
  EventType,
  type ServerHandlers,
} from "../../src/index.ts"
import { createMemoryEventStore } from "../kernel/memory-event-store.ts"

describe("server handlers", () => {
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
