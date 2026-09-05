import { readFile, realpath } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import type { RolloutAssets } from "../kernel/index.ts"
import { createSessionEventHub, type SessionEventHub } from "./event-hub.ts"
import type { ServerHandlers } from "./handlers.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"
import {
  ApiErrorCode,
  type ApiHandlerResult,
  type ApiListProvidersResponse,
  type ApiUserModelPreference,
} from "./protocol.ts"
import { createRequestGate, type RequestGate } from "./request-gate.ts"
import { MessageProcessor } from "./rpc/message-processor.ts"
import { attachWebsocketRpcTransport } from "./rpc/websocket-transport.ts"
import type { ProjectStore } from "./sqlite-project-store.ts"
import type { UserConfigStore } from "./user-config.ts"

export type YakitoriStaticAssets = {
  readonly directory: string
}

type YakitoriHttpServerCommonOptions = {
  readonly eventHub?: SessionEventHub
  readonly staticAssets?: YakitoriStaticAssets
  readonly projectStore?: ProjectStore
  readonly providers?: () => Promise<ApiListProvidersResponse>
  readonly userConfig?: UserConfigStore
  readonly availableProviders?: readonly string[]
  readonly rolloutAssets?: RolloutAssets
  readonly reportOperationalFailure?: OperationalFailureReporter
  readonly requestGate?: RequestGate
  readonly messageProcessor?: MessageProcessor
  readonly userAgent?: string
}

export type YakitoriHttpServerOptions = YakitoriHttpServerCommonOptions & {
  readonly handlers: ServerHandlers
}

export function createYakitoriHttpServer(options: YakitoriHttpServerOptions) {
  if (options.handlers === undefined) {
    throw new Error(
      "Injected handlers are required. Use createYakitoriApplication() for an owned runtime.",
    )
  }
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter
  const requestGate = options.requestGate ?? createRequestGate()
  const eventHub =
    options.eventHub ??
    createSessionEventHub({ reportOperationalFailure: reporter })
  const handlers = options.handlers
  const projectStore = options.projectStore
  const providers = options.providers
  const userConfig = options.userConfig
  const availableProviders = options.availableProviders
  const rolloutAssets = options.rolloutAssets
  const staticAssets =
    options.staticAssets === undefined
      ? undefined
      : createStaticAssetContext(options.staticAssets.directory)

  const server = createServer((request, response) => {
    void requestGate
      .run(async () => {
        try {
          await handleRequest(request, response, rolloutAssets, staticAssets)
        } catch (error) {
          if (!(error instanceof URIError)) {
            reportOperationalFailure(reporter, {
              component: "http-server",
              operation: "handle-request",
              cause: error,
            })
          }
          writeUnhandledError(response, error)
        }
        await waitForResponseCompletion(response)
      })
      .then((result) => {
        if (!result.accepted) {
          writeResult(
            response,
            errorResult(
              503,
              ApiErrorCode.InternalError,
              "Server is shutting down.",
            ),
          )
        }
      })
  })

  const messageProcessor =
    options.messageProcessor ??
    new MessageProcessor({
      handlers,
      eventHub,
      reportOperationalFailure: reporter,
      ...(projectStore === undefined ? {} : { projectStore }),
      ...(providers === undefined ? {} : { providers }),
      ...(userConfig === undefined ? {} : { userConfig }),
      ...(availableProviders === undefined ? {} : { availableProviders }),
      ...(options.userAgent === undefined
        ? {}
        : { userAgent: options.userAgent }),
    })
  attachWebsocketRpcTransport(server, {
    processor: messageProcessor,
    reportOperationalFailure: reporter,
  })
  return server
}

function waitForResponseCompletion(response: ServerResponse): Promise<void> {
  if (response.writableFinished || response.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      response.off("finish", finish)
      response.off("close", finish)
      resolve()
    }
    response.once("finish", finish)
    response.once("close", finish)
  })
}

// The HTTP surface is intentionally small: API traffic moved to the JSON-RPC
// WebSocket transport (/rpc). What remains is the health probe, the rollout
// asset binary route, static GUI assets with the SPA fallback, and CORS.
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  rolloutAssets: RolloutAssets | undefined,
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

  if (route.kind === "readRolloutAsset") {
    if (rolloutAssets === undefined) {
      writeResult(
        response,
        errorResult(404, ApiErrorCode.NotFound, "Route not found."),
      )
      return
    }
    try {
      const file = await rolloutAssets.openRead({
        rolloutId: route.rolloutId,
        path: route.path,
      })
      response.writeHead(200, {
        "Cache-Control": "private, no-store",
        "Content-Length": file.totalBytes,
        "Content-Type": rolloutAssetContentType(route.path),
        "X-Content-Type-Options": "nosniff",
      })
      await pipeline(file.stream, response)
    } catch {
      if (response.headersSent) {
        response.destroy()
        return
      }
      writeResult(
        response,
        errorResult(404, ApiErrorCode.NotFound, "Rollout asset was not found."),
      )
    }
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

  if (
    method === "GET" &&
    segments.length > 4 &&
    segments[0] === "rollouts" &&
    typeof segments[1] === "string" &&
    segments[2] === "assets" &&
    segments[3] === "attachments"
  ) {
    return {
      kind: "readRolloutAsset",
      rolloutId: segments[1],
      path: segments.slice(3).join("/"),
    }
  }

  return { kind: "notFound", segments }
}

function requireBodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function requireUserModelPreference(
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

function applyCorsHeaders(
  response: ServerResponse,
  origin: string | undefined,
): void {
  if (origin !== undefined) {
    response.setHeader("Access-Control-Allow-Origin", origin)
    response.setHeader("Vary", "Origin")
  }
  // Only GET routes remain on the HTTP surface; API traffic moved to /rpc.
  response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS")
  response.setHeader("Access-Control-Allow-Headers", "content-type")
}

function requestOrigin(request: IncomingMessage): string | undefined {
  if (typeof request.headers.origin === "string") return request.headers.origin
  return undefined
}

export function isAllowedCorsOrigin(origin: string): boolean {
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
  | { readonly kind: "health" }
  | { readonly kind: "notFound"; readonly segments: readonly string[] }
  | {
      readonly kind: "readRolloutAsset"
      readonly rolloutId: string
      readonly path: string
    }

function rolloutAssetContentType(path: string): string {
  const extension = extname(path).toLowerCase()
  if (extension === ".gif") return "image/gif"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".png") return "image/png"
  if (extension === ".webp") return "image/webp"
  if (extension === ".json") return "application/json; charset=utf-8"
  return "text/plain; charset=utf-8"
}
