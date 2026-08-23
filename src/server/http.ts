import { readFile, realpath } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { extname, join, resolve, sep } from "node:path"
import {
  createSessionKernel,
  type EventEnvelope,
  type EventStore,
  isYakitoriError,
  type SessionKernel,
  type SessionFiles,
  type StoredEventEnvelope,
} from "../kernel/index.ts"
import type {
  LiveSessionEvent,
  TransientEventHub,
} from "../runtime/live-events.ts"
import { createDurableEventHub, type DurableEventHub } from "./event-hub.ts"
import { createServerHandlers, type ServerHandlers } from "./handlers.ts"
import type { ProjectRegistry } from "./project-registry.ts"
import {
  ApiErrorCode,
  type ApiHandlerResult,
  type ApiListProvidersResponse,
  type ApiUserModelPreference,
} from "./protocol.ts"
import type { UserConfigStore } from "./user-config.ts"

export type YakitoriStaticAssets = {
  readonly directory: string
}

type YakitoriHttpServerCommonOptions = {
  readonly eventHub?: DurableEventHub
  readonly transientHub?: TransientEventHub
  readonly staticAssets?: YakitoriStaticAssets
  readonly projectRegistry?: ProjectRegistry
  readonly providers?: () => Promise<ApiListProvidersResponse>
  readonly userConfig?: UserConfigStore
  readonly availableProviders?: readonly string[]
  readonly sessionFiles?: SessionFiles
}

const maxServedSessionImageBytes = 4 * 1024 * 1024

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
  const projectRegistry = options.projectRegistry
  const providers = options.providers
  const userConfig = options.userConfig
  const availableProviders = options.availableProviders
  const sessionFiles = options.sessionFiles

  const staticAssets =
    options.staticAssets === undefined
      ? undefined
      : createStaticAssetContext(options.staticAssets.directory)

  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      handlers,
      eventHub,
      transientHub,
      projectRegistry,
      providers,
      userConfig,
      availableProviders,
      sessionFiles,
      staticAssets,
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

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: ServerHandlers,
  eventHub: DurableEventHub,
  transientHub: TransientEventHub | undefined,
  projectRegistry: ProjectRegistry | undefined,
  providers: (() => Promise<ApiListProvidersResponse>) | undefined,
  userConfig: UserConfigStore | undefined,
  availableProviders: readonly string[] | undefined,
  sessionFiles: SessionFiles | undefined,
  staticAssets: StaticAssetContext | undefined,
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

  if (route.kind === "listProjects") {
    if (projectRegistry === undefined) {
      writeResult(
        response,
        errorResult(404, ApiErrorCode.NotFound, "Route not found."),
      )
      return
    }
    writeJson(response, 200, { projects: await projectRegistry.list() })
    return
  }

  if (route.kind === "addProject") {
    if (projectRegistry === undefined) {
      writeResult(
        response,
        errorResult(404, ApiErrorCode.NotFound, "Route not found."),
      )
      return
    }
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    const path = requireBodyRecord(body.value).path
    if (typeof path !== "string" || path.trim() === "") {
      writeResult(
        response,
        errorResult(
          400,
          ApiErrorCode.InvalidInput,
          "path must be a non-empty string.",
        ),
      )
      return
    }
    try {
      writeJson(response, 200, { projects: await projectRegistry.add(path) })
    } catch (error) {
      writeResult(response, projectRegistryError(error))
    }
    return
  }

  if (route.kind === "listProviders") {
    if (providers === undefined) {
      writeResult(
        response,
        errorResult(404, ApiErrorCode.NotFound, "Route not found."),
      )
      return
    }
    writeJson(response, 200, await providers())
    return
  }

  if (route.kind === "updateUserPreference") {
    if (userConfig === undefined) {
      writeResult(
        response,
        errorResult(404, ApiErrorCode.NotFound, "Route not found."),
      )
      return
    }
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    const preference = requireUserModelPreference(
      body.value,
      availableProviders ?? [],
    )
    if (!preference.ok) {
      writeResult(response, preference.result)
      return
    }
    writeJson(response, 200, {
      userPreference: await userConfig.write(preference.value),
    })
    return
  }

  if (route.kind === "listSessions") {
    writeResult(
      response,
      await handlers.listSessions({
        ...optionalQueryNumber(url, "limit"),
        ...optionalQueryString(url, "cursor"),
        ...optionalQueryString(url, "workingDirectory"),
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

  if (route.kind === "readSessionFile") {
    if (sessionFiles === undefined) {
      writeResult(
        response,
        errorResult(404, ApiErrorCode.NotFound, "Route not found."),
      )
      return
    }
    try {
      const file = await sessionFiles.readRange(
        { sessionId: route.sessionId, path: route.path },
        0,
        maxServedSessionImageBytes + 1,
      )
      if (file.totalBytes > maxServedSessionImageBytes) {
        writeResult(
          response,
          errorResult(413, ApiErrorCode.InvalidInput, "Image is too large."),
        )
        return
      }
      const bytes = file.bytes
      response.writeHead(200, {
        "Cache-Control": "private, no-store",
        "Content-Length": bytes.byteLength,
        "Content-Type": sessionFileContentType(route.path),
        "X-Content-Type-Options": "nosniff",
      })
      response.end(bytes)
    } catch {
      writeResult(
        response,
        errorResult(404, ApiErrorCode.NotFound, "Session file was not found."),
      )
    }
    return
  }

  if (route.kind === "deleteSession") {
    writeResult(
      response,
      await handlers.deleteSession({ sessionId: route.sessionId }),
    )
    return
  }

  if (route.kind === "forkSession") {
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    writeResult(
      response,
      await handlers.forkSession({
        ...requireBodyRecord(body.value),
        sessionId: route.sessionId,
      }),
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

  if (route.kind === "compactSession") {
    const body = await readJson(request)
    if (!body.ok) {
      writeResult(response, body.result)
      return
    }
    writeResult(
      response,
      await handlers.compactSession({
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
  // Decoded first-segment API paths keep the JSON 404 so clients can tell a
  // missing API resource apart from the SPA fallback.
  if (
    request.method === "GET" &&
    staticAssets !== undefined &&
    !isApiPath(route.segments) &&
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

  if (method === "GET" && segments.length === 1 && segments[0] === "projects") {
    return { kind: "listProjects" }
  }

  if (
    method === "POST" &&
    segments.length === 1 &&
    segments[0] === "projects"
  ) {
    return { kind: "addProject" }
  }

  if (
    method === "GET" &&
    segments.length === 1 &&
    segments[0] === "providers"
  ) {
    return { kind: "listProviders" }
  }

  if (
    method === "PUT" &&
    segments.length === 1 &&
    segments[0] === "user-preference"
  ) {
    return { kind: "updateUserPreference" }
  }

  if (segments[0] !== "sessions" || typeof segments[1] !== "string") {
    return { kind: "notFound", segments }
  }

  if (method === "GET" && segments.length === 2) {
    return { kind: "readSession", sessionId: segments[1] }
  }

  if (
    method === "GET" &&
    segments.length > 4 &&
    segments[2] === "files" &&
    segments[3] === "attachments"
  ) {
    return {
      kind: "readSessionFile",
      sessionId: segments[1],
      path: segments.slice(3).join("/"),
    }
  }

  if (method === "DELETE" && segments.length === 2) {
    return { kind: "deleteSession", sessionId: segments[1] }
  }

  if (method === "POST" && segments.length === 3 && segments[2] === "fork") {
    return { kind: "forkSession", sessionId: segments[1] }
  }

  if (method === "POST" && segments.length === 3 && segments[2] === "inputs") {
    return { kind: "admitInput", sessionId: segments[1] }
  }

  if (method === "POST" && segments.length === 3 && segments[2] === "compact") {
    return { kind: "compactSession", sessionId: segments[1] }
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

  return { kind: "notFound", segments }
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
          candidate.type === event.type &&
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

  const snapshot = await handlers.readSession({ sessionId })
  if (responseClosed) {
    cleanup()
    return
  }
  if (!snapshot.ok) {
    cleanup()
    writeResult(response, snapshot)
    return
  }
  const replayThrough = snapshot.body.session.seq
  let replayAfter = after
  let replayed = await handlers.readSessionEvents({
    sessionId,
    after: replayAfter,
    through: replayThrough,
    limit: 500,
  })
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
  for (;;) {
    if (responseClosed) {
      cleanup()
      return
    }
    lastSequence = writeSseEvents(response, replayed.body.events, lastSequence)
    if (replayed.body.nextAfter === undefined) break
    replayAfter = replayed.body.nextAfter
    replayed = await handlers.readSessionEvents({
      sessionId,
      after: replayAfter,
      through: replayThrough,
      limit: 500,
    })
    if (!replayed.ok) {
      cleanup()
      response.destroy()
      return
    }
  }
  pendingEvents.sort((left, right) => left.seq - right.seq)
  lastSequence = writeSseEvents(response, pendingEvents, lastSequence)
  pendingEvents.length = 0
  response.write("event: session.replay-complete\n")
  response.write("data: {}\n\n")
  live = true
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
  // Four 4 MiB decoded images expand under base64; leave room for JSON and text.
  const maxRequestBodyBytes = 24 * 1024 * 1024
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxRequestBodyBytes) return undefined
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

function requireUserModelPreference(
  value: unknown,
  availableProviders: readonly string[],
):
  | { readonly ok: true; readonly value: ApiUserModelPreference }
  | { readonly ok: false; readonly result: ApiHandlerResult<never> } {
  const record = requireBodyRecord(value)
  const provider = nonEmptyString(record.provider)
  if (provider === undefined) {
    return {
      ok: false,
      result: errorResult(
        400,
        ApiErrorCode.InvalidInput,
        "provider must be a non-empty string.",
      ),
    }
  }
  if (!availableProviders.includes(provider)) {
    return {
      ok: false,
      result: errorResult(
        400,
        ApiErrorCode.InvalidInput,
        "provider must name a registered provider.",
      ),
    }
  }
  const model = nonEmptyString(record.model)
  if (model === undefined) {
    return {
      ok: false,
      result: errorResult(
        400,
        ApiErrorCode.InvalidInput,
        "model must be a non-empty string.",
      ),
    }
  }
  const effort = optionalNonEmptyString(record, "effort")
  if (!effort.ok) return effort
  const speed = optionalNonEmptyString(record, "speed")
  if (!speed.ok) return speed
  return {
    ok: true,
    value: {
      provider,
      model,
      ...(effort.value === undefined ? {} : { effort: effort.value }),
      ...(speed.value === undefined ? {} : { speed: speed.value }),
    },
  }
}

function optionalNonEmptyString(
  record: Record<string, unknown>,
  field: "effort" | "speed",
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly result: ApiHandlerResult<never> } {
  if (!(field in record)) return { ok: true, value: undefined }
  const value = nonEmptyString(record[field])
  if (value !== undefined) return { ok: true, value }
  return {
    ok: false,
    result: errorResult(
      400,
      ApiErrorCode.InvalidInput,
      `${field} must be a non-empty string when provided.`,
    ),
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
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

function projectRegistryError(error: unknown): ApiHandlerResult<never> {
  // resolveWorkspaceDirectory rejects invalid paths with a plain Error;
  // anything else is an unexpected registry failure.
  if (error instanceof Error && !isYakitoriError(error)) {
    return errorResult(400, ApiErrorCode.InvalidInput, error.message)
  }
  return errorResult(
    500,
    ApiErrorCode.InternalError,
    "Unexpected server error.",
  )
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

function isApiPath(segments: readonly string[]): boolean {
  return (
    segments[0] === "sessions" ||
    segments[0] === "health" ||
    segments[0] === "projects" ||
    segments[0] === "providers" ||
    segments[0] === "user-preference"
  )
}

type StaticAssetContext = {
  readonly root: string
  realpathRoot(): Promise<string | undefined>
}

function createStaticAssetContext(directory: string): StaticAssetContext {
  const root = resolve(directory)
  let cached: string | undefined
  return {
    root,
    async realpathRoot() {
      // A missing root is not cached: the GUI directory may appear later.
      if (cached === undefined) cached = await realpathOrMissing(root)
      return cached
    },
  }
}

async function serveStaticAsset(
  response: ServerResponse,
  staticAssets: StaticAssetContext,
  pathname: string,
): Promise<boolean> {
  const root = staticAssets.root
  const resolved = resolve(root, `.${decodeURIComponent(pathname)}`)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    return serveSpaFallback(response, root)
  }

  const candidate = pathname === "/" ? join(root, "index.html") : resolved
  // Lexical containment is not enough: readFile follows symlinks, so the
  // candidate's real path must stay inside the real root. A missing
  // candidate falls through to readStaticFile and keeps the SPA fallback.
  const realCandidate = await realpathOrMissing(candidate)
  if (realCandidate !== undefined) {
    const realRoot = await staticAssets.realpathRoot()
    if (
      realRoot === undefined ||
      (realCandidate !== realRoot &&
        !realCandidate.startsWith(`${realRoot}${sep}`))
    ) {
      return serveSpaFallback(response, root)
    }
  }

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
  } catch (error) {
    // Missing paths and directories fall through to the SPA fallback or 404;
    // other I/O errors surface as an unhandled 500.
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

async function realpathOrMissing(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ENOTDIR" ||
      error.code === "EISDIR")
  )
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
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
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
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS",
  )
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

type Route =
  | { readonly kind: "admitInput"; readonly sessionId: string }
  | { readonly kind: "compactSession"; readonly sessionId: string }
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
  | { readonly kind: "deleteSession"; readonly sessionId: string }
  | { readonly kind: "forkSession"; readonly sessionId: string }
  | { readonly kind: "health" }
  | { readonly kind: "listSessions" }
  | { readonly kind: "notFound"; readonly segments: readonly string[] }
  | { readonly kind: "readSession"; readonly sessionId: string }
  | {
      readonly kind: "readSessionFile"
      readonly sessionId: string
      readonly path: string
    }
  | { readonly kind: "listProjects" }
  | { readonly kind: "addProject" }
  | { readonly kind: "listProviders" }
  | { readonly kind: "updateUserPreference" }
  | {
      readonly kind: "resolvePermission"
      readonly sessionId: string
      readonly turnId: string
      readonly permissionRequestId: string
    }
  | { readonly kind: "streamSessionEvents"; readonly sessionId: string }

function sessionFileContentType(path: string): string {
  const extension = extname(path).toLowerCase()
  if (extension === ".gif") return "image/gif"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".png") return "image/png"
  if (extension === ".webp") return "image/webp"
  if (extension === ".json") return "application/json; charset=utf-8"
  return "text/plain; charset=utf-8"
}

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
