import { mkdtemp, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  type ApiAdmitInputResponse,
  type ApiCreateSessionResponse,
  ApiErrorCode,
  type ApiListSessionsResponse,
  type ApiReadSessionResponse,
  createSessionKernel,
  createYakitoriHttpServer,
  type EventEnvelope,
  EventType,
} from "../../src/index.ts"
import { createMemoryEventStore } from "../kernel/memory-event-store.ts"

describe("HTTP server", () => {
  it("adapts session handlers to JSON routes", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {
          title: "HTTP slice",
        },
      )

      expect(created.status).toBe(201)
      expect(created.body.session).toMatchObject({
        id: created.body.event.sessionId,
        title: "HTTP slice",
      })

      const listed = await getJson<ApiListSessionsResponse>(
        `${baseUrl}/sessions?limit=10`,
      )

      expect(listed.status).toBe(200)
      expect(listed.body.sessions).toEqual([
        expect.objectContaining({
          id: created.body.session.id,
          title: "HTTP slice",
        }),
      ])
    })
  })

  it("returns explicit JSON errors for invalid requests", async () => {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        body: "{",
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          code: ApiErrorCode.InvalidInput,
          message: "Request body must be valid JSON.",
        },
      })

      const invalidPath = await fetch(`${baseUrl}/sessions/%E0%A4%A`)
      expect(invalidPath.status).toBe(400)
      expect(await invalidPath.json()).toEqual({
        error: {
          code: ApiErrorCode.InvalidInput,
          message: "Request path is invalid.",
        },
      })

      const invalidSessionId = await fetch(`${baseUrl}/sessions/session_bad`)
      expect(invalidSessionId.status).toBe(400)
      expect(await invalidSessionId.json()).toMatchObject({
        error: {
          code: ApiErrorCode.InvalidInput,
        },
      })
    })
  })

  it("rejects non-loopback CORS origins", async () => {
    await withHttpServer(async (baseUrl) => {
      const rejected = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
        },
        body: "{}",
      })

      expect(rejected.status).toBe(403)
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull()
      expect(await rejected.json()).toEqual({
        error: {
          code: ApiErrorCode.Forbidden,
          message: "Origin is not allowed.",
        },
      })

      const allowed = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:5173",
        },
        body: "{}",
      })

      expect(allowed.status).toBe(201)
      expect(allowed.headers.get("access-control-allow-origin")).toBe(
        "http://127.0.0.1:5173",
      )
    })
  })

  it("rejects non-finite JSON and malformed parent session ids", async () => {
    await withHttpServer(async (baseUrl) => {
      const nonFinite = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: '{"metadata":{"bad":1e999}}',
      })

      expect(nonFinite.status).toBe(400)
      expect(await nonFinite.json()).toMatchObject({
        error: {
          code: ApiErrorCode.InvalidInput,
        },
      })

      const invalidParent = await postJson(`${baseUrl}/sessions`, {
        parentSessionId: "session_bad",
      })

      expect(invalidParent.status).toBe(400)
      expect(invalidParent.body).toMatchObject({
        error: {
          code: ApiErrorCode.InvalidInput,
        },
      })
    })
  })

  it("streams durable session events after replay", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {},
      )
      const abort = new AbortController()
      const stream = await fetch(
        `${baseUrl}/sessions/${created.body.session.id}/events?after=1`,
        {
          signal: abort.signal,
        },
      )

      expect(stream.status).toBe(200)
      expect(stream.headers.get("content-type")).toContain("text/event-stream")

      const nextEvent = readNextSessionEvent(stream)
      const admitted = await postJson(
        `${baseUrl}/sessions/${created.body.session.id}/inputs`,
        {
          requestId: "request_http-stream",
          content: {
            kind: "text",
            text: "tail this",
          },
        },
      )

      expect(admitted.status).toBe(201)
      const event = await nextEvent
      abort.abort()

      expect(event).toMatchObject({
        seq: 2,
        type: EventType.InputAdmitted,
        data: {
          content: {
            kind: "text",
            text: "tail this",
          },
        },
      })
    })
  })

  it("replays durable session events when the stream opens", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {},
      )
      const abort = new AbortController()
      const stream = await fetch(
        `${baseUrl}/sessions/${created.body.session.id}/events?after=0`,
        {
          signal: abort.signal,
        },
      )

      expect(stream.status).toBe(200)
      const event = await readNextSessionEvent(stream)
      abort.abort()

      expect(event).toMatchObject({
        seq: 1,
        type: EventType.SessionCreated,
      })
    })
  })

  it("resumes streams after the latest query or Last-Event-ID cursor", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {},
      )
      const inputsUrl = `${baseUrl}/sessions/${created.body.session.id}/inputs`
      await postJson(inputsUrl, {
        requestId: "request_http-resume-1",
        content: { kind: "text", text: "first" },
      })
      await postJson(inputsUrl, {
        requestId: "request_http-resume-2",
        content: { kind: "text", text: "second" },
      })

      for (const cursors of [
        { after: 1, lastEventId: 2 },
        { after: 2, lastEventId: 1 },
      ]) {
        const abort = new AbortController()
        const stream = await fetch(
          `${baseUrl}/sessions/${created.body.session.id}/events?after=${cursors.after}`,
          {
            headers: {
              "Last-Event-ID": String(cursors.lastEventId),
            },
            signal: abort.signal,
          },
        )
        const event = await readNextSessionEvent(stream)
        abort.abort()

        expect(event).toMatchObject({
          seq: 3,
          type: EventType.InputAdmitted,
          data: {
            content: { kind: "text", text: "second" },
          },
        })
      }
    })
  })

  it("rejects every malformed session event cursor", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {},
      )

      for (const cursors of [
        { after: "1.5", lastEventId: "2", invalidField: "after" },
        {
          after: "1",
          lastEventId: "not-a-sequence",
          invalidField: "Last-Event-ID",
        },
        {
          after: "9007199254740992",
          lastEventId: "1",
          invalidField: "after",
        },
        {
          after: "1",
          lastEventId: "9007199254740992",
          invalidField: "Last-Event-ID",
        },
      ]) {
        const abort = new AbortController()
        const response = await fetch(
          `${baseUrl}/sessions/${created.body.session.id}/events?after=${cursors.after}`,
          {
            headers: {
              "Last-Event-ID": cursors.lastEventId,
            },
            signal: abort.signal,
          },
        )

        try {
          expect(response.status).toBe(400)
          expect(await response.json()).toEqual({
            error: {
              code: ApiErrorCode.InvalidInput,
              message: `${cursors.invalidField} must be a non-negative integer sequence.`,
            },
          })
        } finally {
          abort.abort()
        }
      }
    })
  })

  it("serves sessions through the default SQLite store", async () => {
    await withSqliteHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {
          title: "SQLite session",
        },
      )
      const listed = await getJson<ApiListSessionsResponse>(
        `${baseUrl}/sessions?limit=10`,
      )

      expect(created.status).toBe(201)
      expect(listed.status).toBe(200)
      expect(listed.body.sessions).toEqual([
        expect.objectContaining({
          id: created.body.session.id,
          title: "SQLite session",
        }),
      ])
    })
  })

  it("deduplicates retried admissions through the default SQLite store", async () => {
    await withSqliteHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {},
      )
      const url = `${baseUrl}/sessions/${created.body.session.id}/inputs`
      const request = {
        requestId: "request_http-retry",
        content: {
          kind: "text",
          text: "persist once",
        },
      }

      const first = await postJson<ApiAdmitInputResponse>(url, request)
      const replayed = await postJson<ApiAdmitInputResponse>(url, request)
      const changed = await postJson(url, {
        ...request,
        content: {
          kind: "text",
          text: "persist something else",
        },
      })
      const read = await getJson<ApiReadSessionResponse>(
        `${baseUrl}/sessions/${created.body.session.id}`,
      )

      expect(first.status).toBe(201)
      expect(first.body.requestId).toBe(request.requestId)
      expect(replayed.status).toBe(200)
      expect(replayed.body).toEqual(first.body)
      expect(changed.status).toBe(409)
      expect(changed.body).toMatchObject({
        error: {
          code: ApiErrorCode.Conflict,
        },
      })
      expect(read.body.session.seq).toBe(2)
      expect(read.body.session.counts.inputs).toBe(1)
    })
  })
})

async function withHttpServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createYakitoriHttpServer({
    kernel: createSessionKernel(createMemoryEventStore()),
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  try {
    const address = server.address()
    if (!isAddressInfo(address)) throw new Error("Expected TCP address.")
    await run(`http://${address.address}:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
      server.closeAllConnections()
    })
  }
}

async function withSqliteHttpServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-http-"))
  const server = createYakitoriHttpServer({ rootDir })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  try {
    const address = server.address()
    if (!isAddressInfo(address)) throw new Error("Expected TCP address.")
    await run(`http://${address.address}:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
      server.closeAllConnections()
    })
    await rm(rootDir, { recursive: true, force: true })
  }
}

async function postJson<T = unknown>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: (await response.json()) as T,
  }
}

async function getJson<T>(url: string) {
  const response = await fetch(url)
  return {
    status: response.status,
    body: (await response.json()) as T,
  }
}

async function readNextSessionEvent(
  response: Response,
): Promise<EventEnvelope> {
  if (!response.body) throw new Error("Expected a streaming response body.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  return await withTimeout(async () => {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("SSE stream ended before an event.")
      buffer += decoder.decode(chunk.value, { stream: true })

      const event = parseSseEvent(buffer)
      if (event) return event
    }
  })
}

function parseSseEvent(buffer: string): EventEnvelope | undefined {
  const block = buffer.split("\n\n").find((candidate) => {
    return candidate.includes("\ndata: ") || candidate.startsWith("data: ")
  })
  const data = block
    ?.split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length)

  if (data === undefined) return undefined
  return JSON.parse(data) as EventEnvelope
}

async function withTimeout<T>(run: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for SSE event."))
        }, 1_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function isAddressInfo(value: unknown): value is AddressInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "address" in value &&
    "port" in value
  )
}
