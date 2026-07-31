import { readFile } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, resolve, sep } from "node:path"
import {
  createSessionKernel,
  type EventEnvelope,
  type EventStore,
  type SessionKernel,
  type StoredEventEnvelope,
} from "../kernel/index.ts"
import type {
  LiveSessionEvent,
  TransientEventHub,
} from "../runtime/live-events.ts"
import { createDurableEventHub, type DurableEventHub } from "./event-hub.ts"
import { createServerHandlers, type ServerHandlers } from "./handlers.ts"
import { ApiErrorCode, type ApiHandlerResult } from "./protocol.ts"

export type YakitoriStaticAssets = {
  readonly directory: string
}

type YakitoriHttpServerCommonOptions = {
  readonly eventHub?: DurableEventHub
  readonly transientHub?: TransientEventHub
  readonly staticAssets?: YakitoriStaticAssets
}

export type YakitoriHttpServerOptions = YakitoriHttpServerCommonOptions &
  (
    | {
        readonly handlers: ServerHandlers
        readonly kernel?: never
        readonly eventStore?: never
      }
    | {
        readonly kernel: SessionKernel
        readonly handlers?: never
        readonly eventStore?: never
      }
    | {
        readonly eventStore: EventStore
        readonly handlers?: never
        readonly kernel?: never
      }
  )

export function createYakitoriHttpServer(options: YakitoriHttpServerOptions) {
  const eventHub = options.eventHub ?? createDurableEventHub()
  const transientHub = options.transientHub
  const handlers =
    options.handlers ??
    createServerHandlers(resolveServerKernel(options), { eventHub })

  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      handlers,
      eventHub,
      transientHub,
      options.staticAssets,
    ).catch((error) => {
      writeUnhandledError(response, error)
    })
  })
  return server
}

function resolveServerKernel(
  options: YakitoriHttpServerOptions,
): SessionKernel {
  if (options.kernel !== undefined) return options.kernel
  if (options.eventStore !== undefined) {
    return createSessionKernel(options.eventStore)
  }
  throw new Error(
    "An injected kernel, eventStore, or handlers is required. Use createYakitoriApplication() for an owned persistent runtime.",
  )
}

export async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!isAddressInfo(address)) {
    throw new Error("Expected HTTP server to listen on a TCP address.")
  }
  return `http://${address.address}:${address.port}`
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: ServerHandlers,
  eventHub: DurableEventHub,
  transientHub: TransientEventHub | undefined,
  staticAssets: YakitoriStaticAssets | undefined,
): Promise<void> {
  const origin = requestOrigin(request)
  if (origin !== undefined && !isAllowedCorsOrigin(origin)) {
    writeResult(
      response,
      errorResult(403, ApiErrorCode.Forbidden, "Origin is not allowed."),
    )
    return
  }

  applyCorsHeaders(response, origin)

  if (request.method === "OPTIONS") {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const route = routeRequest(request.method ?? "GET", url)

  if (route.kind === "health") {
    writeJson(response, 200, { ok: true })
    return
  }

  if (route.kind === "listSessions") {
    writeResult(
      response,
      await handlers.listSessions({
        ...optionalQueryNumber(url, "limit"),
        ...optionalQueryString(url, "cursor"),
      }),
    )
    return
  }

  if (route.kind === "createSession") {
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    writeResult(response, await handlers.createSession(body.value))
    return
  }

  if (route.kind === "readSession") {
    writeResult(
      response,
      await handlers.readSession({ sessionId: route.sessionId }),
    )
    return
  }

  if (route.kind === "admitInput") {
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    writeResult(
      response,
      await handlers.admitInput({
        ...requireBodyRecord(body.value),
        sessionId: route.sessionId,
      }),
    )
    return
  }

  if (route.kind === "cancelInput") {
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    writeResult(
      response,
      await handlers.cancelInput({
        ...requireBodyRecord(body.value),
        sessionId: route.sessionId,
        inputId: route.inputId,
      }),
    )
    return
  }

  if (route.kind === "cancelTurn") {
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    writeResult(
      response,
      await handlers.cancelTurn({
        ...requireBodyRecord(body.value),
        sessionId: route.sessionId,
        turnId: route.turnId,
      }),
    )
    return
  }

  if (route.kind === "resolvePermission") {
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    writeResult(
      response,
      await handlers.resolvePermission({
        ...requireBodyRecord(body.value),
        sessionId: route.sessionId,
        turnId: route.turnId,
        permissionRequestId: route.permissionRequestId,
      }),
    )
    return
  }

  if (route.kind === "streamSessionEvents") {
    const cursor = resolveEventCursor(
      url.searchParams.get("after") ?? undefined,
      request.headers["last-event-id"],
    )
    if (!cursor.ok) {
      writeResult(response, cursor.result)
      return
    }
    await streamSessionEvents(
      response,
      handlers,
      eventHub,
      transientHub,
      route.sessionId,
      cursor.after,
    )
    return
  }

  // Static serving is GET-only: HEAD and other methods keep the JSON 404.
  // API-shaped prefixes always keep the JSON 404 so clients can tell a
  // missing API resource apart from the SPA fallback.
  if (
    request.method === "GET" &&
    staticAssets !== undefined &&
    !isApiPath(url.pathname) &&
    (await serveStaticAsset(response, staticAssets, url.pathname))
  ) {
    return
  }

  writeResult(
    response,
    errorResult(404, ApiErrorCode.NotFound, "Route not found."),
  )
}

function routeRequest(method: string, url: URL): Route {
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent)

  if (method === "GET" && segments.length === 1 && segments[0] === "health") {
    return { kind: "health" }
  }

  if (method === "GET" && segments.length === 1 && segments[0] === "sessions") {
    return { kind: "listSessions" }
  }

  if (
    method === "POST" &&
    segments.length === 1 &&
    segments[0] === "sessions"
  ) {
    return { kind: "createSession" }
  }

  if (segments[0] !== "sessions" || typeof segments[1] !== "string") {
    return { kind: "notFound" }
  }

  if (method === "GET" && segments.length === 2) {
    return { kind: "readSession", sessionId: segments[1] }
  }

  if (method === "POST" && segments.length === 3 && segments[2] === "inputs") {
    return { kind: "admitInput", sessionId: segments[1] }
  }

  if (method === "GET" && segments.length === 3 && segments[2] === "events") {
    return { kind: "streamSessionEvents", sessionId: segments[1] }
  }

  // POST /sessions/:id/inputs/:inputId/cancel
  if (
    method === "POST" &&
    segments.length === 5 &&
    segments[2] === "inputs" &&
    segments[4] === "cancel" &&
    typeof segments[3] === "string"
  ) {
    return {
      kind: "cancelInput",
      sessionId: segments[1],
      inputId: segments[3],
    }
  }

  // POST /sessions/:id/turns/:turnId/cancel
  if (
    method === "POST" &&
    segments.length === 5 &&
    segments[2] === "turns" &&
    segments[4] === "cancel" &&
    typeof segments[3] === "string"
  ) {
    return {
      kind: "cancelTurn",
      sessionId: segments[1],
      turnId: segments[3],
    }
  }

  // POST /sessions/:id/turns/:turnId/permissions/:id/resolve
  if (
    method === "POST" &&
    segments.length === 7 &&
    segments[2] === "turns" &&
    segments[4] === "permissions" &&
    segments[6] === "resolve" &&
    typeof segments[3] === "string" &&
    typeof segments[5] === "string"
  ) {
    return {
      kind: "resolvePermission",
      sessionId: segments[1],
      turnId: segments[3],
      permissionRequestId: segments[5],
    }
  }

  return { kind: "notFound" }
}

async function streamSessionEvents(
  response: ServerResponse,
  handlers: ServerHandlers,
  eventHub: DurableEventHub,
  transientHub: TransientEventHub | undefined,
  sessionId: string,
  after: number,
): Promise<void> {
  const pendingEvents: EventEnvelope[] = []
  const pendingLive: LiveSessionEvent[] = []
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let live = false
  let lastSequence = 0
  let responseClosed = false
  const subscription = eventHub.subscribe(sessionId, (events) => {
    if (responseClosed) return
    if (!live) {
      pendingEvents.push(...events)
      return
    }
    lastSequence = writeSseEvents(response, events, lastSequence)
  })
  const liveSubscription = transientHub?.subscribe(sessionId, (event) => {
    if (responseClosed) return
    if (!live) {
      // Coalesce by stream id for slow subscribers during replay.
      const index = pendingLive.findIndex(
        (candidate) =>
          candidate.type === "assistant.snapshot" &&
          event.type === "assistant.snapshot" &&
          candidate.streamId === event.streamId,
      )
      if (index >= 0) pendingLive[index] = event
      else pendingLive.push(event)
      return
    }
    writeTransientSseEvent(response, event)
  })
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat)
    subscription.close()
    liveSubscription?.close()
  }

  response.once("close", () => {
    responseClosed = true
    cleanup()
  })

  const replayed = await handlers.readSessionEvents({ sessionId, after })
  if (responseClosed) {
    cleanup()
    return
  }
  if (!replayed.ok) {
    cleanup()
    writeResult(response, replayed)
    return
  }

  writeSseHead(response)
  response.write(": connected\n\n")
  lastSequence = after
  lastSequence = writeSseEvents(response, replayed.body.events, lastSequence)
  live = true
  lastSequence = writeSseEvents(response, pendingEvents, lastSequence)
  pendingEvents.length = 0
  for (const event of pendingLive) writeTransientSseEvent(response, event)
  pendingLive.length = 0

  heartbeat = setInterval(() => {
    if (responseClosed) return
    response.write(": heartbeat\n\n")
  }, 15_000)
}

function writeSseHead(response: ServerResponse): void {
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  })
}

function writeSseEvents(
  response: ServerResponse,
  events: readonly StoredEventEnvelope[],
  lastSequence: number,
): number {
  return events.reduce((sequence, event) => {
    if (event.seq <= sequence) return sequence
    response.write(`id: ${event.seq}\n`)
    response.write("event: session.event\n")
    response.write(`data: ${JSON.stringify(event)}\n\n`)
    return event.seq
  }, lastSequence)
}

function writeTransientSseEvent(
  response: ServerResponse,
  event: LiveSessionEvent,
): void {
  // Transient events never set SSE id and must not advance Last-Event-ID.
  response.write("event: session.transient\n")
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

async function readJson(request: IncomingMessage): Promise<JsonReadResult> {
  const body = await readRequestBody(request)
  if (body === undefined) {
    return {
      ok: false,
      result: errorResult(
        400,
        ApiErrorCode.InvalidInput,
        "Request body is too large.",
      ),
    }
  }
  if (body.trim() === "") {
    return {
      ok: true,
      value: {},
    }
  }

  try {
    return {
      ok: true,
      value: JSON.parse(body),
    }
  } catch {
    return {
      ok: false,
      result: errorResult(
        400,
        ApiErrorCode.InvalidInput,
        "Request body must be valid JSON.",
      ),
    }
  }
}

async function readRequestBody(
  request: IncomingMessage,
): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function requireBodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function writeResult<T>(
  response: ServerResponse,
  result: ApiHandlerResult<T>,
): void {
  writeJson(response, result.status, result.body)
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  })
  response.end(JSON.stringify(body))
}

function errorResult(
  status: number,
  code: ApiErrorCode,
  message: string,
): ApiHandlerResult<never> {
  return {
    ok: false,
    status,
    body: {
      error: {
        code,
        message,
      },
    },
  }
}

function writeUnhandledError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy(error instanceof Error ? error : undefined)
    return
  }

  writeResult(
    response,
    error instanceof URIError
      ? errorResult(400, ApiErrorCode.InvalidInput, "Request path is invalid.")
      : errorResult(
          500,
          ApiErrorCode.InternalError,
          "Unexpected server error.",
        ),
  )
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/sessions") || pathname.startsWith("/health")
}

async function serveStaticAsset(
  response: ServerResponse,
  staticAssets: YakitoriStaticAssets,
  pathname: string,
): Promise<boolean> {
  const root = resolve(staticAssets.directory)
  const resolved = resolve(root, `.${decodeURIComponent(pathname)}`)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    return serveSpaFallback(response, root)
  }

  const candidate = pathname === "/" ? join(root, "index.html") : resolved
  const body = await readStaticFile(candidate)
  if (body !== undefined) {
    writeStaticFile(response, root, candidate, body)
    return true
  }
  return serveSpaFallback(response, root)
}

async function serveSpaFallback(
  response: ServerResponse,
  root: string,
): Promise<boolean> {
  const indexPath = join(root, "index.html")
  const body = await readStaticFile(indexPath)
  if (body === undefined) return false
  writeStaticFile(response, root, indexPath, body)
  return true
}

async function readStaticFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch {
    // Missing paths and directories fall through to the SPA fallback or 404.
    return undefined
  }
}

function writeStaticFile(
  response: ServerResponse,
  root: string,
  path: string,
  body: Buffer,
): void {
  response.writeHead(200, {
    "Cache-Control": staticCacheControl(root, path),
    "Content-Type": staticContentType(path),
  })
  response.end(body)
}

function staticCacheControl(root: string, path: string): string {
  // Vite content-hashes everything under assets/; index.html must revalidate.
  return path.startsWith(`${join(root, "assets")}${sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache"
}

function staticContentType(path: string): string {
  return (
    staticContentTypes[extname(path).toLowerCase()] ??
    "application/octet-stream"
  )
}

const staticContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function optionalQueryString(url: URL, field: string): Record<string, string> {
  const value = url.searchParams.get(field)
  if (value === null) return {}
  return { [field]: value }
}

function optionalQueryNumber(
  url: URL,
  field: string,
): Record<string, number | string> {
  const value = url.searchParams.get(field)
  if (value === null) return {}
  if (/^[0-9]+$/.test(value)) return { [field]: Number(value) }
  return { [field]: value }
}

function resolveEventCursor(
  after: string | undefined,
  lastEventId: string | string[] | undefined,
): EventCursorResult {
  const invalidField = !isOptionalEventSequence(after)
    ? "after"
    : !isOptionalEventSequence(lastEventId)
      ? "Last-Event-ID"
      : undefined
  if (invalidField !== undefined) {
    return {
      ok: false,
      result: errorResult(
        400,
        ApiErrorCode.InvalidInput,
        `${invalidField} must be a non-negative integer sequence.`,
      ),
    }
  }

  const values = [after, lastEventId]
  return {
    ok: true,
    after: Math.max(
      0,
      ...values.flatMap((value) =>
        typeof value === "string" ? [Number(value)] : [],
      ),
    ),
  }
}

function isOptionalEventSequence(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return false
  return Number.isSafeInteger(Number(value))
}

function applyCorsHeaders(
  response: ServerResponse,
  origin: string | undefined,
): void {
  if (origin !== undefined) {
    response.setHeader("Access-Control-Allow-Origin", origin)
    response.setHeader("Vary", "Origin")
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  response.setHeader("Access-Control-Allow-Headers", "content-type")
}

function requestOrigin(request: IncomingMessage): string | undefined {
  if (typeof request.headers.origin === "string") return request.headers.origin
  return undefined
}

function isAllowedCorsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "[::1]")
    )
  } catch {
    return false
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

type Route =
  | { readonly kind: "admitInput"; readonly sessionId: string }
  | {
      readonly kind: "cancelInput"
      readonly sessionId: string
      readonly inputId: string
    }
  | {
      readonly kind: "cancelTurn"
      readonly sessionId: string
      readonly turnId: string
    }
  | { readonly kind: "createSession" }
  | { readonly kind: "health" }
  | { readonly kind: "listSessions" }
  | { readonly kind: "notFound" }
  | { readonly kind: "readSession"; readonly sessionId: string }
  | {
      readonly kind: "resolvePermission"
      readonly sessionId: string
      readonly turnId: string
      readonly permissionRequestId: string
    }
  | { readonly kind: "streamSessionEvents"; readonly sessionId: string }

type JsonReadResult =
  | {
      readonly ok: true
      readonly value: unknown
    }
  | {
      readonly ok: false
      readonly result: ApiHandlerResult<never>
    }

type EventCursorResult =
  | {
      readonly ok: true
      readonly after: number
    }
  | {
      readonly ok: false
      readonly result: ApiHandlerResult<never>
    }
