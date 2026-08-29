import { createHash, randomUUID } from "node:crypto"
import { constants, type ReadStream } from "node:fs"
import {
  copyFile,
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises"
import { basename, dirname, join, posix, resolve, sep } from "node:path"
import type { ImageAttachment, SessionFileReference } from "./events.ts"
import { isGeneratedSessionId } from "./ids.ts"
import { inspectImageBytes } from "./image-metadata.ts"

// Grok Build applies the same per-image send boundary. This is a transport
// safety limit, independent from model context accounting or attachment count.
const MAX_IMAGE_FILE_BYTES = 50_000_000
const MAX_IMAGE_METADATA_BYTES = 1024 * 1024

export type ImageBytesInput = {
  readonly name: string
  readonly data: Uint8Array
}

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

export class ImageAttachmentConflictError extends Error {
  override readonly name = "ImageAttachmentConflictError"
}

export type PreparedImageAttachments = {
  readonly attachments: readonly ImageAttachment[]
  rollback(): Promise<void>
}

export type SessionFiles = {
  importImagePaths(
    sessionId: string,
    ownerId: string,
    paths: readonly string[],
  ): Promise<readonly ImageAttachment[]>
  importImageBytes(
    sessionId: string,
    ownerId: string,
    images: readonly ImageBytesInput[],
  ): Promise<readonly ImageAttachment[]>
  promoteImageAttachments(
    sessionId: string,
    ownerId: string,
    attachments: readonly ImageAttachment[],
  ): Promise<PreparedImageAttachments>
  copyImageAttachments(
    sessionId: string,
    ownerId: string,
    attachments: readonly ImageAttachment[],
  ): Promise<readonly ImageAttachment[]>
  discardRequestImageAttachments(
    sessionId: string,
    ownerId: string,
  ): Promise<void>
  discardSessionFiles(sessionId: string): Promise<void>
  collectUnreferencedSessionFiles(
    referencedSessionIds: ReadonlySet<string>,
  ): Promise<void>
  discardDraftImageAttachments(
    attachments: readonly ImageAttachment[],
  ): Promise<void>
  cleanupStagingImageAttachments(): Promise<void>
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
  openRead(
    reference: SessionFileReference,
  ): Promise<{ readonly stream: ReadStream; readonly totalBytes: number }>
  resolve(reference: SessionFileReference): string
}

export function createSessionFiles(sessionsDir: string): SessionFiles {
  const root = resolve(sessionsDir)

  function resolveReference(reference: SessionFileReference): string {
    requireSessionId(reference.sessionId)
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
    async importImagePaths(sessionId, ownerId, paths) {
      requireSessionId(sessionId)
      requirePathSegment(ownerId, "attachment owner")
      const ownerDirectory = fileNameForId(ownerId)
      const attachments: ImageAttachment[] = []
      try {
        for (const [index, sourcePath] of paths.entries()) {
          const name = basename(sourcePath)
          requireAttachmentName(name)
          const snapshot = await copyImageSnapshot({
            root,
            sourcePath,
            stagingDirectory: stagingOwnerDirectory(
              root,
              sessionId,
              ownerDirectory,
            ),
          })
          const reference = imageReference(
            sessionId,
            "staging",
            ownerDirectory,
            index,
            snapshot.mediaType,
          )
          await linkTemporaryFile(
            snapshot.path,
            resolveReference(reference),
            dirname(resolveReference(reference)),
            snapshot.sizeBytes,
          )
          await rm(snapshot.path, { force: true })
          attachments.push({
            name,
            mediaType: snapshot.mediaType,
            sizeBytes: snapshot.sizeBytes,
            detail: "high",
            file: reference,
          })
        }
        return attachments
      } catch (error) {
        await rm(stagingOwnerDirectory(root, sessionId, ownerDirectory), {
          recursive: true,
          force: true,
        })
        throw error
      }
    },

    async importImageBytes(sessionId, ownerId, images) {
      requireSessionId(sessionId)
      requirePathSegment(ownerId, "attachment owner")
      const ownerDirectory = fileNameForId(ownerId)
      const attachments: ImageAttachment[] = []
      try {
        for (const [index, image] of images.entries()) {
          requireAttachmentName(image.name)
          const bytes = Buffer.from(image.data)
          requireImageSize(bytes.byteLength)
          const { mediaType } = inspectImageBytes(bytes)
          const reference = imageReference(
            sessionId,
            "staging",
            ownerDirectory,
            index,
            mediaType,
          )
          await writeOnce(root, resolveReference(reference), bytes)
          attachments.push({
            name: image.name,
            mediaType,
            sizeBytes: bytes.byteLength,
            detail: "high",
            file: reference,
          })
        }
        return attachments
      } catch (error) {
        await rm(stagingOwnerDirectory(root, sessionId, ownerDirectory), {
          recursive: true,
          force: true,
        })
        throw error
      }
    },

    async promoteImageAttachments(sessionId, ownerId, attachments) {
      requireSessionId(sessionId)
      requirePathSegment(ownerId, "attachment owner")
      const ownerDirectory = fileNameForId(ownerId)
      const promoted: ImageAttachment[] = []
      const createdPaths: string[] = []
      const rollback = () =>
        Promise.all(createdPaths.map((path) => rm(path, { force: true }))).then(
          () => undefined,
        )
      try {
        for (const [index, attachment] of attachments.entries()) {
          requireDraftImageAttachment(sessionId, attachment)
          const file = imageReference(
            sessionId,
            "requests",
            ownerDirectory,
            index,
            attachment.mediaType,
          )
          const targetPath = resolveReference(file)
          const existing = await inspectStoredImageIfPresent(targetPath)
          if (existing !== undefined) {
            requireMatchingImageMetadata(existing, attachment)
            const sourcePath = resolveReference(attachment.file)
            const source = await inspectStoredImageIfPresent(sourcePath)
            if (source !== undefined) {
              requireMatchingImageMetadata(source, attachment)
              const [sourceBytes, existingBytes] = await Promise.all([
                readFile(sourcePath),
                readFile(targetPath),
              ])
              if (!sourceBytes.equals(existingBytes)) {
                throw new ImageAttachmentConflictError(
                  "A different image already exists for this request.",
                )
              }
            }
            promoted.push({ ...attachment, file })
            continue
          }
          const sourcePath = resolveReference(attachment.file)
          const source = await inspectStoredImage(sourcePath)
          requireMatchingImageMetadata(source, attachment)
          if (await linkOnce(root, sourcePath, targetPath, source.sizeBytes)) {
            createdPaths.push(targetPath)
          }
          promoted.push({ ...attachment, file })
        }
        return { attachments: promoted, rollback }
      } catch (error) {
        await rollback()
        throw error
      }
    },

    async copyImageAttachments(sessionId, ownerId, attachments) {
      requireSessionId(sessionId)
      requirePathSegment(ownerId, "attachment owner")
      const ownerDirectory = fileNameForId(ownerId)
      const copied: ImageAttachment[] = []
      const createdPaths: string[] = []
      try {
        for (const [index, attachment] of attachments.entries()) {
          const sourcePath = resolveReference(attachment.file)
          const source = await inspectStoredImage(sourcePath)
          requireMatchingImageMetadata(source, attachment)
          const file = imageReference(
            sessionId,
            "requests",
            ownerDirectory,
            index,
            attachment.mediaType,
          )
          const targetPath = resolveReference(file)
          const existing = await inspectStoredImageIfPresent(targetPath)
          if (existing === undefined) {
            if (
              await linkOnce(root, sourcePath, targetPath, source.sizeBytes)
            ) {
              createdPaths.push(targetPath)
            }
          } else {
            requireMatchingImageMetadata(existing, attachment)
          }
          copied.push({ ...attachment, file })
        }
        return copied
      } catch (error) {
        await Promise.all(createdPaths.map((path) => rm(path, { force: true })))
        throw error
      }
    },

    async discardRequestImageAttachments(sessionId, ownerId) {
      requireSessionId(sessionId)
      requirePathSegment(ownerId, "attachment owner")
      await rm(
        join(
          root,
          sessionId,
          "files",
          "attachments",
          "requests",
          fileNameForId(ownerId),
        ),
        { recursive: true, force: true },
      )
    },

    async discardSessionFiles(sessionId) {
      requireSessionId(sessionId)
      await rm(join(root, sessionId), { recursive: true, force: true })
    },

    async collectUnreferencedSessionFiles(referencedSessionIds) {
      const entries = await readdirIfPresent(root)
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isDirectory() &&
              isGeneratedSessionId(entry.name) &&
              !referencedSessionIds.has(entry.name),
          )
          .map((entry) =>
            rm(join(root, entry.name), { recursive: true, force: true }),
          ),
      )
    },

    async discardDraftImageAttachments(attachments) {
      await Promise.all(
        attachments.map(async (attachment) => {
          requireDraftImageAttachment(attachment.file.sessionId, attachment)
          await rm(resolveReference(attachment.file), { force: true })
        }),
      )
    },

    async cleanupStagingImageAttachments() {
      const entries = await readdirIfPresent(root)
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            rm(join(root, entry.name, "files", "attachments", "staging"), {
              recursive: true,
              force: true,
            }),
          ),
      )
    },

    async prepareCommandFiles(sessionId, toolCallId) {
      requireSessionId(sessionId)
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

    async openRead(reference) {
      const path = resolveReference(reference)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const file = await handle.stat()
        if (!file.isFile())
          throw new Error("Session file is not a regular file.")
        return {
          stream: handle.createReadStream(),
          totalBytes: file.size,
        }
      } catch (error) {
        await handle.close()
        throw error
      }
    },

    resolve: resolveReference,
  }
}

function requireSessionId(sessionId: string): void {
  if (isGeneratedSessionId(sessionId)) return
  throw new Error(`Invalid session id ${sessionId}.`)
}

function imageReference(
  sessionId: string,
  namespace: "staging" | "requests",
  ownerDirectory: string,
  index: number,
  mediaType: ImageAttachment["mediaType"],
): SessionFileReference {
  return {
    sessionId,
    path: posix.join(
      "attachments",
      namespace,
      ownerDirectory,
      `${String(index + 1)}${imageExtension(mediaType)}`,
    ),
  }
}

function stagingOwnerDirectory(
  root: string,
  sessionId: string,
  ownerDirectory: string,
): string {
  return join(
    root,
    sessionId,
    "files",
    "attachments",
    "staging",
    ownerDirectory,
  )
}

async function inspectStoredImage(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const file = await handle.stat()
    if (!file.isFile() || file.size === 0) {
      throw new Error("Draft image must be a non-empty regular file.")
    }
    requireImageSize(file.size)
    const header = Buffer.alloc(Math.min(file.size, MAX_IMAGE_METADATA_BYTES))
    await handle.read(header, 0, header.byteLength, 0)
    return {
      mediaType: inspectImageBytes(header).mediaType,
      sizeBytes: file.size,
    }
  } finally {
    await handle.close()
  }
}

async function inspectStoredImageIfPresent(path: string) {
  try {
    return await inspectStoredImage(path)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

function requireMatchingImageMetadata(
  stored: Awaited<ReturnType<typeof inspectStoredImage>>,
  attachment: ImageAttachment,
): void {
  if (
    stored.sizeBytes !== attachment.sizeBytes ||
    stored.mediaType !== attachment.mediaType
  ) {
    throw new Error("Draft image metadata does not match its file.")
  }
}

function requireAttachmentName(name: string): void {
  if (
    name.length === 0 ||
    Buffer.byteLength(name, "utf8") > 255 ||
    name.includes("\0")
  ) {
    throw new Error("Image attachment name is invalid.")
  }
}

function requireDraftImageAttachment(
  sessionId: string,
  attachment: ImageAttachment,
): void {
  if (
    attachment.file.sessionId !== sessionId ||
    !isStagingImagePath(attachment.file.path)
  ) {
    throw new Error("Image attachment is not a draft owned by this Session.")
  }
  requireAttachmentName(attachment.name)
}

function isStagingImagePath(path: string): boolean {
  const segments = path.split("/")
  return (
    segments.length === 4 &&
    segments[0] === "attachments" &&
    segments[1] === "staging" &&
    segments[2] !== "" &&
    segments[3] !== ""
  )
}

function requireImageSize(sizeBytes: number): void {
  if (sizeBytes <= 0 || sizeBytes > MAX_IMAGE_FILE_BYTES) {
    throw new Error("Image must be a non-empty file no larger than 50 MB.")
  }
}

async function copyImageSnapshot(input: {
  readonly root: string
  readonly sourcePath: string
  readonly stagingDirectory: string
}) {
  await ensureDirectoryChain(input.root, input.stagingDirectory)
  const temporaryPath = join(
    input.stagingDirectory,
    `.snapshot-${randomUUID()}.tmp`,
  )
  try {
    await copyFile(input.sourcePath, temporaryPath, constants.COPYFILE_EXCL)
    const handle = await open(temporaryPath, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    const metadata = await inspectStoredImage(temporaryPath)
    return { ...metadata, path: temporaryPath }
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

async function linkOnce(
  root: string,
  sourcePath: string,
  path: string,
  sourceBytes: number,
): Promise<boolean> {
  const directory = dirname(path)
  await ensureDirectoryChain(root, directory)
  try {
    await link(sourcePath, path)
    await syncDirectory(directory)
    return true
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    const existing = await stat(path)
    if (!existing.isFile() || existing.size !== sourceBytes) {
      throw new Error("A different Session file already exists at this path.")
    }
    const [source, target] = await Promise.all([
      readFile(sourcePath),
      readFile(path),
    ])
    if (!source.equals(target)) {
      throw new ImageAttachmentConflictError(
        "A different image already exists for this request.",
      )
    }
    return false
  }
}

async function linkTemporaryFile(
  temporaryPath: string,
  path: string,
  directory: string,
  sourceBytes: number,
): Promise<void> {
  try {
    await link(temporaryPath, path)
    await syncDirectory(directory)
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    const existing = await stat(path)
    if (!existing.isFile() || existing.size !== sourceBytes) {
      throw new Error("A different Session file already exists at this path.")
    }
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

async function readdirIfPresent(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}
