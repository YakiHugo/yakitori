import { createWriteStream } from "node:fs"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  AttachmentConflictError,
  type RolloutAssets,
} from "../core/rollout-assets.ts"
import {
  ATTACHMENT_FILE_SAFETY_BYTES,
  isAttachmentUploadId,
} from "../protocol/attachment-upload.ts"
import type { UserAttachment } from "../protocol/asset-types.ts"

// Bound parallel disk/parser work, abandoned drafts, and stalled bodies. These
// are implementation safety limits, not provider or product attachment quotas.
const MAX_ACTIVE_REQUESTS = 4
const MAX_DRAFTS = 200
const MAX_DRAFT_BYTES = 1_000_000_000
const BODY_DEADLINE_MS = 120_000

export type AttachmentUploads = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
  release(rolloutIds: readonly string[]): void
}>

class UploadError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// This is a single-user loopback transport, not authentication. Upload IDs
// select an isolated server namespace, never arbitrary client-supplied paths.
// Remote access requires identity-scoped authorization for both RPC and assets.
export async function createAttachmentUploads(
  options: Readonly<{
    rolloutAssets: RolloutAssets
    temporaryDirectory: string
    allowedOrigins?: readonly string[]
    releaseDraftRolloutAssets(rolloutIds: readonly string[]): void
  }>,
): Promise<AttachmentUploads> {
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  for (const origin of allowedOrigins) {
    const url = new URL(origin)
    if (
      url.origin !== origin ||
      url.protocol !== "http:" ||
      !isLoopback(url.hostname)
    )
      throw new Error(
        "Attachment upload origins must be exact loopback HTTP origins.",
      )
  }
  // Application startup already owns the store lock. Incoming files never
  // survive a restart; accepted drafts use the existing rollout lifecycle.
  await rm(options.temporaryDirectory, { recursive: true, force: true })
  await mkdir(options.temporaryDirectory, { recursive: true, mode: 0o700 })
  await chmod(options.temporaryDirectory, 0o700)
  const pending = new Map<string, Promise<void>>()
  const drafts = new Map<string, UserAttachment>()
  let active = 0
  let draftBytes = 0

  function release(rolloutIds: readonly string[]) {
    for (const rolloutId of rolloutIds) {
      const draft = drafts.get(rolloutId)
      if (draft) {
        draftBytes -= draft.sizeBytes
        drafts.delete(rolloutId)
      }
    }
  }

  async function discard(rolloutId: string) {
    await options.rolloutAssets.discardEphemeralRolloutFiles(rolloutId)
    release([rolloutId])
    options.releaseDraftRolloutAssets([rolloutId])
  }

  return {
    release,
    async handle(request, response) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (!url.pathname.startsWith("/attachments/")) return false
      try {
        const uploadId = url.pathname.slice("/attachments/uploads/".length)
        if (
          !url.pathname.startsWith("/attachments/uploads/") ||
          !isAttachmentUploadId(uploadId) ||
          url.search
        )
          throw new UploadError(404, "Attachment upload was not found.")
        requireLocalRequest(request, allowedOrigins)
        const origin = request.headers.origin
        if (origin) {
          response.setHeader("Access-Control-Allow-Origin", origin)
          response.setHeader("Vary", "Origin")
        }
        response.setHeader("Cache-Control", "no-store")
        if (request.method === "OPTIONS") {
          response.setHeader(
            "Access-Control-Allow-Methods",
            "PUT,DELETE,OPTIONS",
          )
          response.setHeader(
            "Access-Control-Allow-Headers",
            "content-type,x-yakitori-attachment,x-attachment-name",
          )
          response.writeHead(204)
          response.end()
          return true
        }
        if (request.headers["x-yakitori-attachment"] !== "upload")
          throw new UploadError(
            403,
            "An explicit attachment upload request is required.",
          )
        if (request.method !== "PUT" && request.method !== "DELETE")
          throw new UploadError(
            405,
            "Use PUT or DELETE for an attachment upload.",
          )
        if (
          request.method === "DELETE" &&
          (request.headers["transfer-encoding"] !== undefined ||
            (request.headers["content-length"] !== undefined &&
              request.headers["content-length"] !== "0"))
        )
          throw new UploadError(
            400,
            "Attachment deletion must not contain a body.",
          )
        if (active >= MAX_ACTIVE_REQUESTS)
          throw new UploadError(429, "Too many attachment requests are active.")
        const rolloutId = `draft_upload_${uploadId.replaceAll("-", "")}`
        const previous = pending.get(uploadId) ?? Promise.resolve()
        active++
        let finish!: () => void
        const current = new Promise<void>((resolve) => {
          finish = resolve
        })
        pending.set(uploadId, current)
        try {
          await previous
          if (request.method === "DELETE") {
            await discard(rolloutId)
            response.writeHead(204)
            response.end()
            return true
          }
          if (request.destroyed) return true
          if (
            request.headers["content-type"] !== "application/octet-stream" ||
            request.headers["content-encoding"] !== undefined
          )
            throw new UploadError(
              415,
              "Attachments require unencoded application/octet-stream bytes.",
            )
          const header = request.headers["x-attachment-name"]
          let name: string
          try {
            name = typeof header === "string" ? decodeURIComponent(header) : ""
          } catch {
            throw new UploadError(400, "Invalid attachment name.")
          }
          if (
            !name ||
            Buffer.byteLength(name) > 255 ||
            [...name].some(
              (character) =>
                character.charCodeAt(0) < 32 ||
                character.charCodeAt(0) === 127 ||
                character === "/" ||
                character === "\\",
            ) ||
            name === "." ||
            name === ".."
          )
            throw new UploadError(400, "Invalid attachment name.")
          const existing = drafts.get(rolloutId)
          if (existing && existing.name !== name)
            throw new UploadError(
              409,
              "This upload ID already belongs to a different attachment.",
            )
          if (
            !existing &&
            (drafts.size + active > MAX_DRAFTS ||
              draftBytes + active * ATTACHMENT_FILE_SAFETY_BYTES >
                MAX_DRAFT_BYTES)
          )
            throw new UploadError(
              429,
              "Attachment draft storage is full. Remove unused attachments before uploading more.",
            )
          const length = request.headers["content-length"]
          if (
            length !== undefined &&
            (!/^\d+$/.test(length) ||
              Number(length) <= 0 ||
              Number(length) > ATTACHMENT_FILE_SAFETY_BYTES)
          )
            throw new UploadError(
              413,
              "Attachment exceeds the nonempty 50 MB safety boundary.",
            )
          const directory = await mkdtemp(
            join(options.temporaryDirectory, "upload-"),
          )
          const temporaryPath = join(directory, "content")
          const controller = new AbortController()
          const timeout = setTimeout(() => {
            controller.abort()
            // Aborting IncomingMessage can leave its HTTP response/socket open.
            // End both sides so stalled uploads cannot retain the request gate.
            response.destroy()
          }, BODY_DEADLINE_MS)
          let size = 0
          let attachment: UserAttachment
          try {
            await pipeline(
              request,
              new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  size += chunk.byteLength
                  callback(
                    size > ATTACHMENT_FILE_SAFETY_BYTES
                      ? new UploadError(
                          413,
                          "Attachment exceeds the 50 MB safety boundary.",
                        )
                      : null,
                    chunk,
                  )
                },
              }),
              createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
              { signal: controller.signal },
            )
            clearTimeout(timeout)
            if (size === 0 || (length !== undefined && size !== Number(length)))
              throw new UploadError(
                400,
                "Attachment body is empty or incomplete.",
              )
            const [imported] =
              await options.rolloutAssets.importAttachmentPaths(
                rolloutId,
                "upload",
                [temporaryPath],
              )
            if (!imported)
              throw new Error("Attachment import did not return an attachment.")
            attachment = { ...imported, name }
            if (existing && drafts.get(rolloutId) !== existing) {
              // Admission can release the draft while a lost-response upload
              // replay is validating. Never resurrect it outside the budget.
              await discard(rolloutId)
              throw new UploadError(
                409,
                "This attachment draft has already been released.",
              )
            }
            if (!existing) {
              drafts.set(rolloutId, attachment)
              draftBytes += attachment.sizeBytes
            }
          } catch (error) {
            // A failed replay must never delete the earlier successful upload.
            if (!existing) await discard(rolloutId)
            if (error instanceof AttachmentConflictError)
              throw new UploadError(409, error.message)
            if (
              error instanceof UploadError ||
              isSystemError(error) ||
              controller.signal.aborted ||
              request.aborted
            )
              throw error
            throw new UploadError(
              400,
              error instanceof Error
                ? error.message
                : "Attachment could not be imported.",
            )
          } finally {
            clearTimeout(timeout)
            await rm(directory, { recursive: true, force: true })
          }
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          })
          response.end(JSON.stringify({ attachment }))
        } finally {
          active--
          finish()
          if (pending.get(uploadId) === current) pending.delete(uploadId)
        }
      } catch (error) {
        if (response.destroyed || request.aborted) {
          response.destroy()
          if (error instanceof UploadError || isTransportAbort(error))
            return true
        }
        if (!(error instanceof UploadError)) throw error
        response.once("finish", () => request.destroy())
        response.writeHead(error.status, {
          Connection: "close",
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        })
        response.end(JSON.stringify({ error: { message: error.message } }))
      }
      return true
    },
  }
}

function requireLocalRequest(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
) {
  const localAddress = request.socket.localAddress
  const remoteAddress = request.socket.remoteAddress
  if (
    !localAddress ||
    !remoteAddress ||
    !isLoopback(localAddress) ||
    !isLoopback(remoteAddress)
  )
    throw new UploadError(
      403,
      "Attachment uploads require a loopback connection.",
    )
  const host = request.headers.host
  const authority = host ? URL.parse(`http://${host}`) : null
  if (
    !authority ||
    authority.host !== host ||
    !isLoopback(authority.hostname) ||
    Number(authority.port || 80) !== request.socket.localPort
  )
    throw new UploadError(403, "Attachment upload host is not allowed.")
  const origin = request.headers.origin
  if (
    origin !== undefined &&
    origin !== authority.origin &&
    !allowedOrigins.has(origin)
  )
    throw new UploadError(403, "Attachment upload origin is not allowed.")
  // Missing Origin is useful for non-browser local clients, not authentication.
  // Browsers advertising a cross-site request must never use that exception.
  if (
    origin === undefined &&
    request.headers["sec-fetch-site"] !== undefined &&
    request.headers["sec-fetch-site"] !== "same-origin"
  )
    throw new UploadError(403, "Attachment upload origin is required.")
}

function isLoopback(host: string): boolean {
  if (["localhost", "::1", "[::1]"].includes(host)) return true
  const ipv4 = host.startsWith("::ffff:") ? host.slice(7) : host
  return (
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4) &&
    ipv4.split(".").every((part) => Number(part) <= 255)
  )
}

function isSystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error
}

function isTransportAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    [
      "ABORT_ERR",
      "ECONNRESET",
      "EPIPE",
      "ERR_STREAM_PREMATURE_CLOSE",
      "ERR_STREAM_DESTROYED",
    ].includes(String(error.code))
  )
}
