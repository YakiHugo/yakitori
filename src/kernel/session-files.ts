import { constants } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import {
  link,
  mkdir,
  open,
  readFile,
  rm,
  type FileHandle,
} from "node:fs/promises"
import { dirname, join, posix, resolve, sep } from "node:path"
import type {
  ImageAttachment,
  InlineImageAttachment,
  SessionFileReference,
} from "./events.ts"
import { assertEventStoreSessionId } from "./event-store.ts"

export type PreparedCommandFiles = {
  readonly stdout: {
    readonly reference: SessionFileReference
    readonly path: string
  }
  readonly stderr: {
    readonly reference: SessionFileReference
    readonly path: string
  }
}

export type SessionFiles = {
  persistImageAttachments(
    sessionId: string,
    ownerId: string,
    attachments: readonly InlineImageAttachment[],
  ): Promise<readonly ImageAttachment[]>
  prepareCommandFiles(
    sessionId: string,
    toolCallId: string,
  ): Promise<PreparedCommandFiles>
  read(reference: SessionFileReference): Promise<Buffer>
  readRange(
    reference: SessionFileReference,
    offset: number,
    limit: number,
  ): Promise<{ readonly bytes: Buffer; readonly totalBytes: number }>
  resolve(reference: SessionFileReference): string
}

export function createSessionFiles(sessionsDir: string): SessionFiles {
  const root = resolve(sessionsDir)

  function resolveReference(reference: SessionFileReference): string {
    assertEventStoreSessionId(reference.sessionId)
    requireRelativeFilePath(reference.path)
    const filesDir = join(root, reference.sessionId, "files")
    const path = resolve(filesDir, reference.path)
    if (path !== filesDir && !path.startsWith(`${filesDir}${sep}`)) {
      throw new Error("Session file path escapes its Session directory.")
    }
    return path
  }

  async function createEmptyFile(
    reference: SessionFileReference,
  ): Promise<string> {
    const path = resolveReference(reference)
    await ensureDirectoryChain(root, dirname(path))
    const handle = await open(path, "w", 0o600)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    return path
  }

  return {
    async persistImageAttachments(sessionId, ownerId, attachments) {
      assertEventStoreSessionId(sessionId)
      requirePathSegment(ownerId, "attachment owner")
      const ownerDirectory = fileNameForId(ownerId)
      return Promise.all(
        attachments.map(async (attachment, index) => {
          const bytes = Buffer.from(attachment.data, "base64")
          if (bytes.byteLength !== attachment.sizeBytes) {
            throw new Error(
              `Attachment ${attachment.name} size changed before persistence.`,
            )
          }
          const reference = {
            sessionId,
            path: posix.join(
              "attachments",
              ownerDirectory,
              `${String(index + 1)}${imageExtension(attachment.mediaType)}`,
            ),
          }
          const path = resolveReference(reference)
          await writeOnce(root, path, bytes)
          return {
            name: attachment.name,
            mediaType: attachment.mediaType,
            sizeBytes: attachment.sizeBytes,
            file: reference,
          }
        }),
      )
    },

    async prepareCommandFiles(sessionId, toolCallId) {
      assertEventStoreSessionId(sessionId)
      requirePathSegment(toolCallId, "tool call id")
      const toolDirectory = fileNameForId(toolCallId)
      const stdout = {
        sessionId,
        path: posix.join("tools", toolDirectory, "stdout.log"),
      }
      const stderr = {
        sessionId,
        path: posix.join("tools", toolDirectory, "stderr.log"),
      }
      const [stdoutPath, stderrPath] = await Promise.all([
        createEmptyFile(stdout),
        createEmptyFile(stderr),
      ])
      return {
        stdout: { reference: stdout, path: stdoutPath },
        stderr: { reference: stderr, path: stderrPath },
      }
    },

    async read(reference) {
      const path = resolveReference(reference)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile())
          throw new Error("Session file is not a regular file.")
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    },

    async readRange(reference, offset, limit) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("Session file offset must be a non-negative integer.")
      }
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("Session file limit must be a positive integer.")
      }
      const path = resolveReference(reference)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile())
          throw new Error("Session file is not a regular file.")
        const length = Math.min(limit, Math.max(0, stat.size - offset))
        const bytes = Buffer.alloc(length)
        const read = await handle.read(bytes, 0, length, offset)
        return {
          bytes: bytes.subarray(0, read.bytesRead),
          totalBytes: stat.size,
        }
      } finally {
        await handle.close()
      }
    },

    resolve: resolveReference,
  }
}

async function writeOnce(
  root: string,
  path: string,
  bytes: Buffer,
): Promise<void> {
  const directory = dirname(path)
  await ensureDirectoryChain(root, directory)
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  let handle: FileHandle | undefined
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
      handle = undefined
    }

    try {
      await link(temporaryPath, path)
      await syncDirectory(directory)
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const existing = await readFile(path)
      if (!existing.equals(bytes)) {
        throw new Error("A different Session file already exists at this path.")
      }
      await syncDirectory(directory)
    }
  } finally {
    await handle?.close()
    await rm(temporaryPath, { force: true })
  }
}

async function ensureDirectoryChain(root: string, target: string) {
  try {
    await mkdir(root)
    await syncDirectory(dirname(root))
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  const relativePath = target.slice(root.length).replace(/^[/\\]/, "")
  const segments = relativePath
    .split(sep)
    .filter((segment) => segment.length > 0)
  let parent = root
  for (const segment of segments) {
    const directory = join(parent, segment)
    try {
      await mkdir(directory)
      await syncDirectory(parent)
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
    parent = directory
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function requireRelativeFilePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid Session file path.")
  }
}

function requirePathSegment(value: string, name: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[\\/]/.test(value)
  ) {
    throw new Error(`Invalid ${name}.`)
  }
}

function fileNameForId(value: string): string {
  if (
    Buffer.byteLength(value, "utf8") <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.endsWith(".") &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  ) {
    return value
  }
  return `id-${createHash("sha256").update(value).digest("hex")}`
}

function imageExtension(mediaType: ImageAttachment["mediaType"]): string {
  if (mediaType === "image/jpeg") return ".jpg"
  return `.${mediaType.slice("image/".length)}`
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  )
}
