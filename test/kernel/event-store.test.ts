import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createEventEnvelope,
  createInputId,
  createJsonlEventStore,
  createSessionId,
  EventType,
  InputRole,
  YakitoriErrorCode,
  type EventStore,
  type KernelEvent,
} from "../../src/index.ts"

describe("jsonl event store", () => {
  it("returns no events for a missing session log", async () => {
    await withStore(async (context) => {
      expect(await context.store.readEvents(createSessionId())).toEqual([])
    })
  })

  it("lists no sessions when the session directory is missing", async () => {
    await withStore(async (context) => {
      expect(await context.store.listSessions()).toEqual({
        sessions: [],
      })
    })
  })

  it("appends and reads events in session order", async () => {
    await withStore(async (context) => {
      const sessionId = createSessionId()
      const created = await context.store.appendEvent(
        sessionId,
        sessionCreatedEvent(),
      )
      const admitted = await context.store.appendEvent(
        sessionId,
        inputAdmittedEvent(),
      )

      expect(created.seq).toBe(1)
      expect(admitted.seq).toBe(2)
      expect(await context.store.readEvents(sessionId)).toEqual([
        created,
        admitted,
      ])
      expect(
        await readFile(eventsPath(context.rootDir, sessionId), "utf8"),
      ).toBe(`${JSON.stringify(created)}\n${JSON.stringify(admitted)}\n`)
    })
  })

  it("lists session summaries from event logs", async () => {
    await withStore(async (context) => {
      const sessionId = createSessionId()
      const created = await context.store.appendEvent(
        sessionId,
        sessionCreatedEvent(),
      )
      const updated = await context.store.appendEvent(sessionId, {
        type: EventType.SessionMetadataUpdated,
        data: {
          title: "Kernel boundary",
          metadata: {
            stage: "kernel",
          },
        },
      })

      expect(await context.store.listSessions()).toEqual({
        sessions: [
          {
            sessionId,
            seq: 2,
            createdAt: created.createdAt,
            updatedAt: updated.createdAt,
            title: "Kernel boundary",
            metadata: {
              stage: "kernel",
            },
          },
        ],
      })
    })
  })

  it("paginates listed session summaries", async () => {
    await withStore(async (context) => {
      const firstSessionId = createSessionId()
      const secondSessionId = createSessionId()

      await context.store.appendEvent(firstSessionId, sessionCreatedEvent())
      await context.store.appendEvent(secondSessionId, sessionCreatedEvent())

      const firstPage = await context.store.listSessions({ limit: 1 })
      const cursor = firstPage.nextCursor
      if (!cursor) throw new Error("Expected a next cursor.")
      const secondPage = await context.store.listSessions({
        limit: 1,
        cursor,
      })

      expect(firstPage.sessions).toHaveLength(1)
      expect(firstPage.nextCursor).toBeDefined()
      expect(secondPage.sessions).toHaveLength(1)
      expect(secondPage.nextCursor).toBeUndefined()
      expect(
        [...firstPage.sessions, ...secondPage.sessions].map(
          (summary) => summary.sessionId,
        ),
      ).toEqual(expect.arrayContaining([firstSessionId, secondSessionId]))
    })
  })

  it("rejects invalid session list limits and cursors", async () => {
    await withStore(async (context) => {
      await expect(context.store.listSessions({ limit: 0 })).rejects.toThrow(
        "Session list limit must be an integer from 1 to 100.",
      )
      await expect(
        context.store.listSessions({ cursor: "missing" }),
      ).rejects.toThrow("Session list cursor is invalid.")
    })
  })

  it("appends event batches with contiguous sequence numbers", async () => {
    await withStore(async (context) => {
      const sessionId = createSessionId()
      const events = await context.store.appendEvents(sessionId, [
        sessionCreatedEvent(),
        inputAdmittedEvent(),
      ])

      expect(events.map((event) => event.seq)).toEqual([1, 2])
      expect(await context.store.readEvents(sessionId)).toEqual(events)
    })
  })

  it("serializes concurrent appends for the same session", async () => {
    await withStore(async (context) => {
      const sessionId = createSessionId()
      const events = await Promise.all(
        Array.from({ length: 8 }, () =>
          context.store.appendEvent(sessionId, inputAdmittedEvent()),
        ),
      )

      expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(
        (await context.store.readEvents(sessionId)).map((event) => event.seq),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })
  })

  it("rejects unsafe session ids before touching the filesystem", async () => {
    await withStore(async (context) => {
      await expect(context.store.readEvents("../../outside")).rejects.toThrow(
        "Invalid session id ../../outside.",
      )
      await expect(
        context.store.readEvents("../../outside"),
      ).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidArgument,
        details: {
          sessionId: "../../outside",
        },
      })
    })
  })

  it("rejects invalid jsonl content", async () => {
    await withStore(async (context) => {
      const sessionId = createSessionId()

      await mkdir(sessionDir(context.rootDir, sessionId), { recursive: true })
      await writeFile(eventsPath(context.rootDir, sessionId), "{not json}\n")

      await expect(context.store.readEvents(sessionId)).rejects.toThrow(
        "Invalid event JSON at line 1.",
      )
      await expect(context.store.readEvents(sessionId)).rejects.toMatchObject({
        code: YakitoriErrorCode.InvalidEventLog,
        details: {
          lineNumber: 1,
        },
        cause: expect.any(SyntaxError),
      })
    })
  })

  it("rejects listed session logs that do not start with session creation", async () => {
    await withStore(async (context) => {
      const sessionId = createSessionId()

      await mkdir(sessionDir(context.rootDir, sessionId), { recursive: true })
      await writeFile(
        eventsPath(context.rootDir, sessionId),
        `${JSON.stringify(
          createEventEnvelope({
            sessionId,
            seq: 1,
            event: inputAdmittedEvent(),
          }),
        )}\n`,
      )

      await expect(context.store.listSessions()).rejects.toThrow(
        "Session log must start with session.created.",
      )
    })
  })

  it("rejects event logs with invalid payload data", async () => {
    await withStore(async (context) => {
      const sessionId = createSessionId()

      await mkdir(sessionDir(context.rootDir, sessionId), { recursive: true })
      await writeFile(
        eventsPath(context.rootDir, sessionId),
        `${JSON.stringify({
          id: "event_test",
          sessionId,
          seq: 1,
          version: 1,
          createdAt: "2026-07-07T00:00:00.000Z",
          type: EventType.InputAdmitted,
          data: {},
        })}\n`,
      )

      await expect(context.store.readEvents(sessionId)).rejects.toThrow(
        "Invalid event data for input.admitted at line 1.",
      )
    })
  })

  it("rejects event logs with sequence gaps", async () => {
    await withStore(async (context) => {
      const sessionId = createSessionId()
      const envelope = createEventEnvelope({
        sessionId,
        seq: 2,
        event: sessionCreatedEvent(),
      })

      await mkdir(sessionDir(context.rootDir, sessionId), { recursive: true })
      await writeFile(
        eventsPath(context.rootDir, sessionId),
        `${JSON.stringify(envelope)}\n`,
      )

      await expect(context.store.readEvents(sessionId)).rejects.toThrow(
        "Event sequence must be gap-free. Expected 1, got 2.",
      )
    })
  })
})

async function withStore(
  run: (context: {
    readonly rootDir: string
    readonly store: EventStore
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-"))

  try {
    await run({
      rootDir,
      store: createJsonlEventStore({ rootDir }),
    })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

function sessionCreatedEvent(): KernelEvent {
  return {
    type: EventType.SessionCreated,
    data: {
      title: "Yakitori",
    },
  }
}

function inputAdmittedEvent(): KernelEvent {
  return {
    type: EventType.InputAdmitted,
    data: {
      inputId: createInputId(),
      role: InputRole.User,
      content: {
        kind: "text",
        text: "start the kernel",
      },
    },
  }
}

function sessionDir(rootDir: string, sessionId: string): string {
  return join(rootDir, "sessions", sessionId)
}

function eventsPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "events.jsonl")
}
