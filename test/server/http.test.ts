import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  type ApiAdmitInputResponse,
  type ApiCancelInputResponse,
  type ApiCreateSessionResponse,
  ApiErrorCode,
  type ApiForkSessionResponse,
  type ApiListProvidersResponse,
  type ApiListSessionsResponse,
  type ApiReadSessionResponse,
  type ApiUpdateUserModelPreferenceResponse,
  createDurableEventHub,
  createEventEnvelope,
  createInputId,
  createJsonlEventStore,
  createProjectRegistry,
  createServerHandlers,
  createSessionId,
  createSessionKernel,
  createUserConfigStore,
  createYakitoriHttpServer,
  type EventEnvelope,
  EventType,
  type YakitoriHttpServerOptions,
  type YakitoriStaticAssets,
} from "../../src/index.ts"
import { createMemoryEventStore } from "../kernel/memory-event-store.ts"

describe("HTTP server", () => {
  it("requires an injected runtime instead of opening persistence implicitly", () => {
    expect(() =>
      createYakitoriHttpServer({} as YakitoriHttpServerOptions),
    ).toThrow("createYakitoriApplication")
  })

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

  it("routes session deletion", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {},
      )
      const sessionId = created.body.session.id

      const deleted = await fetch(`${baseUrl}/sessions/${sessionId}`, {
        method: "DELETE",
      })
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ sessionId })

      const read = await fetch(`${baseUrl}/sessions/${sessionId}`)
      expect(read.status).toBe(404)

      const invalid = await fetch(`${baseUrl}/sessions/session_bad`, {
        method: "DELETE",
      })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({
        error: { code: ApiErrorCode.InvalidInput },
      })

      const missing = await fetch(`${baseUrl}/sessions/${createSessionId()}`, {
        method: "DELETE",
      })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({
        error: { code: ApiErrorCode.NotFound },
      })
    })
  })

  it("routes pure undo forks and validates fork semantics", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        { title: "Fork route" },
      )
      const admitted = await postJson<ApiAdmitInputResponse>(
        `${baseUrl}/sessions/${created.body.session.id}/inputs`,
        {
          requestId: "request_http_fork",
          content: { kind: "text", text: "undo this" },
        },
      )
      await postJson(
        `${baseUrl}/sessions/${created.body.session.id}/inputs/${admitted.body.inputId}/cancel`,
        {},
      )
      const forkUrl = `${baseUrl}/sessions/${created.body.session.id}/fork`

      for (const invalid of [
        { atInputId: admitted.body.inputId, reason: "redo" },
        { atInputId: admitted.body.inputId, reason: "edit" },
        {
          atInputId: admitted.body.inputId,
          reason: "undo",
          content: { kind: "text", text: "not allowed" },
        },
        {
          atInputId: admitted.body.inputId,
          reason: "undo",
          modelSelection: { provider: "openai", model: "gpt-test" },
        },
      ]) {
        const rejected = await postJson(forkUrl, invalid)
        expect(rejected.status).toBe(400)
        expect(rejected.body).toMatchObject({
          error: { code: ApiErrorCode.InvalidInput },
        })
      }

      const forked = await postJson<ApiForkSessionResponse>(forkUrl, {
        atInputId: admitted.body.inputId,
        reason: "undo",
      })
      expect(forked.status).toBe(201)
      expect(forked.body.session).toMatchObject({
        parentSessionId: created.body.session.id,
        forkedFromInputId: admitted.body.inputId,
        forkReason: "undo",
        title: "Fork route",
        counts: { inputs: 0, pendingInputs: 0, turns: 0 },
      })

      const source = await getJson<ApiReadSessionResponse>(
        `${baseUrl}/sessions/${created.body.session.id}`,
      )
      expect(source.body.session.counts).toMatchObject({
        inputs: 1,
        pendingInputs: 0,
        turns: 0,
      })
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

  it("flushes events buffered during replay before replay-complete", async () => {
    const eventHub = createDurableEventHub()
    let resolveReplayStarted: (() => void) | undefined
    let resolveFinishReplay: (() => void) | undefined
    const replayStarted = new Promise<void>((resolve) => {
      resolveReplayStarted = resolve
    })
    const finishReplay = new Promise<void>((resolve) => {
      resolveFinishReplay = resolve
    })
    const buffered = createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.InputAdmitted,
        data: {
          requestId: "request_buffered",
          inputId: createInputId(),
          role: "user",
          content: { kind: "text", text: "during replay" },
        },
      },
    })
    const handlers = {
      ...createServerHandlers(createSessionKernel(createMemoryEventStore())),
      async readSessionEvents() {
        resolveReplayStarted?.()
        await finishReplay
        return { ok: true as const, status: 200, body: { events: [] } }
      },
    }

    await withListeningServer(
      createYakitoriHttpServer({ handlers, eventHub }),
      async (baseUrl) => {
        const abort = new AbortController()
        const responsePromise = fetch(
          `${baseUrl}/sessions/session_1/events?after=0`,
          { signal: abort.signal },
        )
        await replayStarted
        eventHub.publish([buffered])
        resolveFinishReplay?.()
        const response = await responsePromise
        const text = await readSseUntilReplayComplete(response)
        abort.abort()

        expect(text.indexOf(`data: ${JSON.stringify(buffered)}`)).toBeLessThan(
          text.indexOf("event: session.replay-complete"),
        )
      },
    )
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

  it("serves sessions through an injected JSONL store", async () => {
    await withJsonlHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {
          title: "JSONL session",
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
          title: "JSONL session",
        }),
      ])
    })
  })

  it("deduplicates retried admissions through an injected JSONL store", async () => {
    await withJsonlHttpServer(async (baseUrl) => {
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

  it("cancels a pending input and replays the recorded event", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {},
      )
      const sessionId = created.body.session.id
      const admitted = await postJson<ApiAdmitInputResponse>(
        `${baseUrl}/sessions/${sessionId}/inputs`,
        {
          requestId: "request_http-cancel-input",
          content: {
            kind: "text",
            text: "cancel me",
          },
        },
      )
      expect(admitted.status).toBe(201)

      const cancelUrl = `${baseUrl}/sessions/${sessionId}/inputs/${admitted.body.inputId}/cancel`
      const cancelled = await postJson<ApiCancelInputResponse>(cancelUrl, {
        reason: "user_cancel",
      })

      expect(cancelled.status).toBe(200)
      expect(cancelled.body).toMatchObject({
        sessionId,
        inputId: admitted.body.inputId,
        event: {
          seq: 3,
          type: EventType.InputCancelled,
          data: {
            inputId: admitted.body.inputId,
            reason: "user_cancel",
          },
        },
      })

      const abort = new AbortController()
      const stream = await fetch(
        `${baseUrl}/sessions/${sessionId}/events?after=2`,
        {
          signal: abort.signal,
        },
      )
      const replayed = await readNextSessionEvent(stream)
      abort.abort()

      expect(replayed).toMatchObject({
        seq: 3,
        type: EventType.InputCancelled,
        data: {
          inputId: admitted.body.inputId,
        },
      })

      const again = await postJson(cancelUrl, {})
      expect(again.status).toBe(409)
      expect(again.body).toMatchObject({
        error: {
          code: ApiErrorCode.Conflict,
        },
      })

      const missing = await postJson(
        `${baseUrl}/sessions/${sessionId}/inputs/${createInputId()}/cancel`,
        {},
      )
      expect(missing.status).toBe(404)
      expect(missing.body).toMatchObject({
        error: {
          code: ApiErrorCode.NotFound,
        },
      })

      const malformed = await postJson(
        `${baseUrl}/sessions/${sessionId}/inputs/input_bad/cancel`,
        {},
      )
      expect(malformed.status).toBe(400)
      expect(malformed.body).toMatchObject({
        error: {
          code: ApiErrorCode.InvalidInput,
        },
      })

      const oversizedReason = await postJson(cancelUrl, {
        reason: "x".repeat(513),
      })
      expect(oversizedReason.status).toBe(400)
      expect(oversizedReason.body).toMatchObject({
        error: {
          code: ApiErrorCode.InvalidInput,
        },
      })
    })
  })

  it("bounds the cancel-turn reason like the cancel-input reason", async () => {
    await withHttpServer(async (baseUrl) => {
      const created = await postJson<ApiCreateSessionResponse>(
        `${baseUrl}/sessions`,
        {},
      )
      const sessionId = created.body.session.id
      const cancelUrl = `${baseUrl}/sessions/${sessionId}/turns/turn_test/cancel`

      const oversizedReason = await postJson(cancelUrl, {
        reason: "x".repeat(513),
      })
      expect(oversizedReason.status).toBe(400)
      expect(oversizedReason.body).toMatchObject({
        error: {
          code: ApiErrorCode.InvalidInput,
        },
      })

      const wrongType = await postJson(cancelUrl, { reason: 42 })
      expect(wrongType.status).toBe(400)
      expect(wrongType.body).toMatchObject({
        error: {
          code: ApiErrorCode.InvalidInput,
        },
      })
    })
  })
})

const staticIndexHtml = "<!doctype html><html><body>yakitori</body></html>"
const staticAssetJs = "console.log('yakitori')\n"
const staticSecret = "top secret\n"

describe("HTTP static assets", () => {
  it("serves index.html at the root with revalidation", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      )
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(await response.text()).toBe(staticIndexHtml)
    })
  })

  it("serves hashed assets with an immutable cache header", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/assets/app-abc123.js`)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe(
        "text/javascript; charset=utf-8",
      )
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      )
      expect(await response.text()).toBe(staticAssetJs)
    })
  })

  it("falls back to index.html for unknown client-side routes", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/missing-page`)

      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(await response.text()).toBe(staticIndexHtml)
    })
  })

  it("keeps JSON errors for API-shaped paths", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const malformed = await fetch(`${baseUrl}/sessions/unknown`)
      expect(malformed.status).toBe(400)
      expect(malformed.headers.get("content-type")).toContain(
        "application/json",
      )
      expect(await malformed.json()).toMatchObject({
        error: {
          code: ApiErrorCode.InvalidInput,
        },
      })

      const missing = await fetch(`${baseUrl}/sessions/${createSessionId()}`)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({
        error: {
          code: ApiErrorCode.NotFound,
        },
      })

      const unknownApiPath = await fetch(`${baseUrl}/sessions/unknown/extra`)
      expect(unknownApiPath.status).toBe(404)
      expect(await unknownApiPath.json()).toEqual({
        error: {
          code: ApiErrorCode.NotFound,
          message: "Route not found.",
        },
      })

      const post = await fetch(`${baseUrl}/missing-page`, { method: "POST" })
      expect(post.status).toBe(404)
      expect(await post.json()).toEqual({
        error: {
          code: ApiErrorCode.NotFound,
          message: "Route not found.",
        },
      })
    })
  })

  it("never serves files outside the static directory", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      for (const path of ["/%2e%2e/secret.txt", "/..%2fsecret.txt"]) {
        const response = await fetch(`${baseUrl}${path}`)

        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body).not.toContain(staticSecret)
        expect(body).toBe(staticIndexHtml)
      }
    })
  })

  it("never serves files through symlinks escaping the static directory", async () => {
    await withStaticHttpServer(async (baseUrl, paths) => {
      try {
        await symlink(
          join(paths.rootDir, "secret.txt"),
          join(paths.staticDir, "leak.txt"),
        )
      } catch {
        // Symlink creation needs extra privileges on some platforms.
        return
      }

      const response = await fetch(`${baseUrl}/leak.txt`)

      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).not.toContain(staticSecret)
      expect(body).toBe(staticIndexHtml)
    })
  })

  it("falls back to the SPA for near-miss API prefixes", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      for (const path of ["/sessionsettings", "/healthcheck"]) {
        const response = await fetch(`${baseUrl}${path}`)

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        )
        expect(await response.text()).toBe(staticIndexHtml)
      }
    })
  })

  it("routes encoded API segments like decoded ones", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/%73essions/nope/extra`)

      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(await response.json()).toEqual({
        error: {
          code: ApiErrorCode.NotFound,
          message: "Route not found.",
        },
      })
    })
  })

  it("keeps the JSON 404 for HEAD requests", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`, { method: "HEAD" })

      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
    })
  })

  it("returns the JSON 404 for unknown paths without static assets", async () => {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`)

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: {
          code: ApiErrorCode.NotFound,
          message: "Route not found.",
        },
      })
    })
  })

  it("serves project routes from the configured registry", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-http-projects-"))
    const projectA = join(rootDir, "project-a")
    const projectB = join(rootDir, "project-b")
    await mkdir(projectA)
    await mkdir(projectB)
    try {
      const projectRegistry = createProjectRegistry({
        registryPath: join(rootDir, "projects.json"),
        defaultProject: await realpath(projectA),
      })

      await withListeningServer(
        createYakitoriHttpServer({
          kernel: createSessionKernel(createMemoryEventStore()),
          projectRegistry,
        }),
        async (baseUrl) => {
          const listed = await getJson<{ projects: string[] }>(
            `${baseUrl}/projects`,
          )
          expect(listed.status).toBe(200)
          expect(listed.body.projects).toEqual([await realpath(projectA)])

          const added = await postJson<{ projects: string[] }>(
            `${baseUrl}/projects`,
            { path: projectB },
          )
          expect(added.status).toBe(200)
          expect(added.body.projects).toEqual([
            await realpath(projectA),
            await realpath(projectB),
          ])

          for (const invalid of [{}, { path: "  " }, { path: 42 }]) {
            const rejected = await postJson(`${baseUrl}/projects`, invalid)
            expect(rejected.status).toBe(400)
            expect(rejected.body).toMatchObject({
              error: { code: ApiErrorCode.InvalidInput },
            })
          }

          const nonexistent = await postJson(`${baseUrl}/projects`, {
            path: join(projectB, "missing"),
          })
          expect(nonexistent.status).toBe(400)
          expect(nonexistent.body).toMatchObject({
            error: {
              code: ApiErrorCode.InvalidInput,
              message: expect.stringContaining("Workspace path does not exist"),
            },
          })
        },
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("keeps project routes at 404 without a registry", async () => {
    await withHttpServer(async (baseUrl) => {
      const listed = await fetch(`${baseUrl}/projects`)
      expect(listed.status).toBe(404)

      const added = await postJson(`${baseUrl}/projects`, { path: "/tmp" })
      expect(added.status).toBe(404)
    })
  })

  it("serves the provider catalog from the configured option", async () => {
    const providers: ApiListProvidersResponse = {
      providers: [
        {
          name: "faux",
          defaultModel: "scripted",
          models: [
            { id: "scripted", displayName: "scripted", family: "default" },
          ],
        },
        {
          name: "openai",
          models: [
            {
              id: "gpt-5.1-codex",
              displayName: "GPT-5.1 Codex",
              family: "gpt",
              efforts: ["low", "medium", "high"],
            },
          ],
        },
      ],
      defaultProvider: "faux",
      defaultModel: "scripted",
    }

    await withListeningServer(
      createYakitoriHttpServer({
        kernel: createSessionKernel(createMemoryEventStore()),
        providers: async () => providers,
      }),
      async (baseUrl) => {
        const listed = await getJson<ApiListProvidersResponse>(
          `${baseUrl}/providers`,
        )
        expect(listed.status).toBe(200)
        expect(listed.body).toEqual(providers)
      },
    )
  })

  it("keeps the providers route at 404 without a catalog", async () => {
    await withHttpServer(async (baseUrl) => {
      const listed = await fetch(`${baseUrl}/providers`)
      expect(listed.status).toBe(404)
    })
  })

  it("validates and persists user model preferences", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-http-config-"))
    try {
      const userConfig = createUserConfigStore({
        configPath: join(rootDir, "config.toml"),
      })
      await withListeningServer(
        createYakitoriHttpServer({
          kernel: createSessionKernel(createMemoryEventStore()),
          userConfig,
          availableProviders: ["anthropic", "faux"],
        }),
        async (baseUrl) => {
          for (const invalid of [
            { provider: "", model: "claude-custom" },
            { provider: "anthropic", model: "" },
            { provider: "anthropic", model: "claude-custom", effort: " " },
            { provider: "missing", model: "arbitrary-slug" },
          ]) {
            const response = await putJson(
              `${baseUrl}/user-preference`,
              invalid,
            )
            expect(response.status).toBe(400)
            expect(response.body).toMatchObject({
              error: { code: ApiErrorCode.InvalidInput },
            })
          }

          const accepted = await putJson<ApiUpdateUserModelPreferenceResponse>(
            `${baseUrl}/user-preference`,
            {
              provider: "anthropic",
              model: "unknown-but-valid-slug",
              effort: "high",
            },
          )
          expect(accepted).toEqual({
            status: 200,
            body: {
              userPreference: {
                provider: "anthropic",
                model: "unknown-but-valid-slug",
                effort: "high",
              },
            },
          })
          await expect(userConfig.read()).resolves.toEqual(
            accepted.body.userPreference,
          )
        },
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("keeps the user preference route at 404 without a store", async () => {
    await withHttpServer(async (baseUrl) => {
      const response = await putJson(`${baseUrl}/user-preference`, {
        provider: "faux",
        model: "scripted",
      })
      expect(response.status).toBe(404)
    })
  })
})

async function withHttpServer(
  run: (baseUrl: string) => Promise<void>,
  options?: { readonly staticAssets?: YakitoriStaticAssets },
): Promise<void> {
  await withListeningServer(
    createYakitoriHttpServer({
      kernel: createSessionKernel(createMemoryEventStore()),
      ...options,
    }),
    run,
  )
}

async function withStaticHttpServer(
  run: (
    baseUrl: string,
    paths: { readonly staticDir: string; readonly rootDir: string },
  ) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-static-"))
  const staticDir = join(rootDir, "site")
  try {
    await mkdir(join(staticDir, "assets"), { recursive: true })
    await writeFile(join(staticDir, "index.html"), staticIndexHtml)
    await writeFile(join(staticDir, "assets", "app-abc123.js"), staticAssetJs)
    await writeFile(join(rootDir, "secret.txt"), staticSecret)
    await withHttpServer((baseUrl) => run(baseUrl, { staticDir, rootDir }), {
      staticAssets: { directory: staticDir },
    })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

async function withJsonlHttpServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-http-"))
  const eventStore = createJsonlEventStore({
    sessionsDir: join(rootDir, "sessions"),
  })

  try {
    await withListeningServer(createYakitoriHttpServer({ eventStore }), run)
  } finally {
    await eventStore.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}

async function withListeningServer(
  server: ReturnType<typeof createYakitoriHttpServer>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
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

async function putJson<T = unknown>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "PUT",
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

async function readSseUntilReplayComplete(response: Response): Promise<string> {
  if (!response.body) throw new Error("Expected a streaming response body.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  return await withTimeout(async () => {
    while (!buffer.includes("event: session.replay-complete")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("SSE stream ended during replay.")
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    return buffer
  })
}

function parseSseEvent(buffer: string): EventEnvelope | undefined {
  const block = buffer.split("\n\n").find((candidate) => {
    return (
      (candidate.includes("\ndata: ") || candidate.startsWith("data: ")) &&
      !candidate.includes("event: session.replay-complete")
    )
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
