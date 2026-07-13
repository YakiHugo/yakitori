import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import {
  createJsonlEventStore,
  createSessionKernel,
  type EventEnvelope,
  type EventStore,
  type SessionKernel,
} from "../kernel/index.ts"
import { createDurableEventHub, type DurableEventHub } from "./event-hub.ts"
import { createServerHandlers, type ServerHandlers } from "./handlers.ts"
import { ApiErrorCode, type ApiHandlerResult } from "./protocol.ts"

export type YakitoriHttpServerOptions = {
  readonly eventStore?: EventStore
  readonly eventHub?: DurableEventHub
  readonly kernel?: SessionKernel
  readonly rootDir?: string
}

export function createYakitoriHttpServer(
  options: YakitoriHttpServerOptions = {},
) {
  const eventHub = options.eventHub ?? createDurableEventHub()
  const eventStore =
    options.eventStore ??
    createJsonlEventStore({
      ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    })
  const kernel = options.kernel ?? createSessionKernel(eventStore)
  const handlers = createServerHandlers(kernel, { eventHub })

  return createServer((request, response) => {
    void handleRequest(request, response, handlers, eventHub).catch((error) => {
      writeUnhandledError(response, error)
    })
  })
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

  if (route.kind === "streamSessionEvents") {
    await streamSessionEvents(
      response,
      handlers,
      eventHub,
      route.sessionId,
      url.searchParams.get("after") ?? undefined,
    )
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

  return { kind: "notFound" }
}

async function streamSessionEvents(
  response: ServerResponse,
  handlers: ServerHandlers,
  eventHub: DurableEventHub,
  sessionId: string,
  after: string | undefined,
): Promise<void> {
  const pendingEvents: EventEnvelope[] = []
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
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat)
    subscription.close()
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
  lastSequence = parseSequence(after)
  lastSequence = writeSseEvents(response, replayed.body.events, lastSequence)
  live = true
  lastSequence = writeSseEvents(response, pendingEvents, lastSequence)
  pendingEvents.length = 0

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
  events: readonly EventEnvelope[],
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

function parseSequence(value: string | undefined): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) return 0
  return Number(value)
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
  | { readonly kind: "createSession" }
  | { readonly kind: "health" }
  | { readonly kind: "listSessions" }
  | { readonly kind: "notFound" }
  | { readonly kind: "readSession"; readonly sessionId: string }
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
