import { createHash, randomUUID } from "node:crypto"
import { constants, type ReadStream } from "node:fs"
import {
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
import type { UserAttachment, RolloutAssetReference } from "./events.ts"
import { isStorageKey } from "./ids.ts"
import { inspectImageBytes } from "./image-metadata.ts"

// Bound disk snapshots, allocations and parser input independently of provider
// quotas. A request may contain multiple attachments subject to runtime budgets.
const ATTACHMENT_FILE_SAFETY_BYTES = 50_000_000
const MAX_IMAGE_METADATA_BYTES = 1024 * 1024

export type AttachmentBytesInput = {
  readonly name: string
  readonly data: Uint8Array
}

export class AttachmentConflictError extends Error {
  override readonly name = "AttachmentConflictError"
}

export type PreparedAttachments = {
  readonly attachments: readonly UserAttachment[]
  rollback(): Promise<void>
}

export type RolloutAssetMutationLease = <T>(
  rolloutId: string,
  mutate: () => Promise<T>,
) => Promise<T>

export type RolloutAssets = {
  saveToolFile(
    rolloutId: string,
    toolCallId: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<{ reference: RolloutAssetReference; path: string }>

  importAttachmentPaths(
    rolloutId: string,
    ownerId: string,
    paths: readonly string[],
  ): Promise<readonly UserAttachment[]>
  importAttachmentBytes(
    rolloutId: string,
    ownerId: string,
    items: readonly AttachmentBytesInput[],
  ): Promise<readonly UserAttachment[]>
  promoteAttachments(
    rolloutId: string,
    ownerId: string,
    attachments: readonly UserAttachment[],
  ): Promise<PreparedAttachments>
  copyAttachments(
    rolloutId: string,
    ownerId: string,
    attachments: readonly UserAttachment[],
  ): Promise<PreparedAttachments>
  discardRequestAttachments(rolloutId: string, ownerId: string): Promise<void>
  discardDraftAttachments(attachments: readonly UserAttachment[]): Promise<void>
  discardEphemeralRolloutFiles(rolloutId: string): Promise<void>
  read(reference: RolloutAssetReference): Promise<Buffer>
  openRead(
    reference: RolloutAssetReference,
  ): Promise<{ readonly stream: ReadStream; readonly totalBytes: number }>
  resolve(reference: RolloutAssetReference): string
}

export function createRolloutAssets(
  storageRoot: string,
  options: Readonly<{
    withMutationLease: RolloutAssetMutationLease
    validatePdf?: (bytes: Uint8Array) => Promise<void>
  }>,
): RolloutAssets {
  const storageRootPath = resolve(storageRoot)
  const root = join(storageRootPath, "rollouts")

  function resolveReference(reference: RolloutAssetReference): string {
    requireRolloutId(reference.rolloutId)
    requireRelativeFilePath(reference.path)
    const filesDir = join(root, reference.rolloutId, "files")
    const path = resolve(filesDir, reference.path)
    if (path !== filesDir && !path.startsWith(`${filesDir}${sep}`)) {
      throw new Error("Rollout asset path escapes its rollout directory.")
    }
    return path
  }

  return {
    async discardEphemeralRolloutFiles(rolloutId) {
      requireRolloutId(rolloutId)
      await options.withMutationLease(rolloutId, () =>
        rm(join(root, rolloutId), { recursive: true, force: true }),
      )
    },
    async importAttachmentPaths(rolloutId, ownerId, paths) {
      requireRolloutId(rolloutId)
      requirePathSegment(ownerId, "attachment owner")
      return options.withMutationLease(rolloutId, async () => {
        const ownerDirectory = fileNameForId(ownerId)
        const attachments: UserAttachment[] = []
        const createdPaths: string[] = []
        try {
          for (const [index, sourcePath] of paths.entries()) {
            const name = basename(sourcePath)
            requireAttachmentName(name)
            const snapshot = await copyAttachmentSnapshot({
              validatePdf: options.validatePdf,
              root: join(root, rolloutId),
              sourcePath,
              stagingDirectory: stagingOwnerDirectory(
                root,
                rolloutId,
                ownerDirectory,
              ),
            })
            const reference = attachmentReference(
              rolloutId,
              "staging",
              ownerDirectory,
              index,
              snapshot.mediaType,
            )
            const targetPath = resolveReference(reference)
            try {
              await requireMatchingAttachmentSlot(targetPath)
              if (
                await linkOnce(
                  join(root, rolloutId),
                  snapshot.path,
                  targetPath,
                  snapshot.sizeBytes,
                )
              )
                createdPaths.push(targetPath)
            } finally {
              await rm(snapshot.path, { force: true })
            }
            attachments.push({
              name,
              mediaType: snapshot.mediaType,
              sizeBytes: snapshot.sizeBytes,
              ...(snapshot.mediaType === "application/pdf"
                ? {}
                : { detail: "high" as const }),
              file: reference,
            })
          }
          return attachments
        } catch (error) {
          await Promise.all(
            createdPaths.map((path) => rm(path, { force: true })),
          )
          throw error
        }
      })
    },

    async importAttachmentBytes(rolloutId, ownerId, items) {
      requireRolloutId(rolloutId)
      requirePathSegment(ownerId, "attachment owner")
      return options.withMutationLease(rolloutId, async () => {
        const ownerDirectory = fileNameForId(ownerId)
        const attachments: UserAttachment[] = []
        const createdPaths: string[] = []
        try {
          for (const [index, item] of items.entries()) {
            requireAttachmentName(item.name)
            requireAttachmentSize(item.data.byteLength)
            const bytes = Buffer.from(item.data)
            const { mediaType } = await inspectAttachmentBytes(
              bytes,
              options.validatePdf,
            )
            const reference = attachmentReference(
              rolloutId,
              "staging",
              ownerDirectory,
              index,
              mediaType,
            )
            const targetPath = resolveReference(reference)
            await requireMatchingAttachmentSlot(targetPath)
            if (await writeOnce(join(root, rolloutId), targetPath, bytes))
              createdPaths.push(targetPath)
            attachments.push({
              name: item.name,
              mediaType,
              sizeBytes: bytes.byteLength,
              ...(mediaType === "application/pdf"
                ? {}
                : { detail: "high" as const }),
              file: reference,
            })
          }
          return attachments
        } catch (error) {
          await Promise.all(
            createdPaths.map((path) => rm(path, { force: true })),
          )
          throw error
        }
      })
    },

    async promoteAttachments(rolloutId, ownerId, attachments) {
      requireRolloutId(rolloutId)
      requirePathSegment(ownerId, "attachment owner")
      return options.withMutationLease(rolloutId, async () => {
        const ownerDirectory = fileNameForId(ownerId)
        const promoted: UserAttachment[] = []
        const createdPaths: string[] = []
        const rollback = () =>
          Promise.all(
            createdPaths.map((path) => rm(path, { force: true })),
          ).then(() => undefined)
        try {
          for (const [index, attachment] of attachments.entries()) {
            requireDraftAttachment(rolloutId, attachment)
            const file = attachmentReference(
              rolloutId,
              "requests",
              ownerDirectory,
              index,
              attachment.mediaType,
            )
            const targetPath = resolveReference(file)
            await requireMatchingAttachmentSlot(targetPath)
            const existing = await inspectStoredAttachmentIfPresent(
              targetPath,
              options.validatePdf,
            )
            if (existing !== undefined) {
              requireMatchingAttachmentMetadata(existing, attachment, true)
              const sourcePath = resolveReference(attachment.file)
              const source = await inspectStoredAttachmentIfPresent(
                sourcePath,
                options.validatePdf,
              )
              if (source !== undefined) {
                requireMatchingAttachmentMetadata(source, attachment)
                const [sourceBytes, existingBytes] = await Promise.all([
                  readFile(sourcePath),
                  readFile(targetPath),
                ])
                if (!sourceBytes.equals(existingBytes)) {
                  throw new AttachmentConflictError(
                    "A different attachment already exists for this request.",
                  )
                }
              }
              promoted.push({ ...attachment, file })
              continue
            }
            const sourcePath = resolveReference(attachment.file)
            const source = await inspectStoredAttachment(
              sourcePath,
              options.validatePdf,
            )
            requireMatchingAttachmentMetadata(source, attachment)
            if (
              await linkOnce(
                join(root, rolloutId),
                sourcePath,
                targetPath,
                source.sizeBytes,
              )
            ) {
              createdPaths.push(targetPath)
            }
            promoted.push({ ...attachment, file })
          }
          return { attachments: promoted, rollback }
        } catch (error) {
          await rollback()
          throw error
        }
      })
    },

    async copyAttachments(rolloutId, ownerId, attachments) {
      requireRolloutId(rolloutId)
      requirePathSegment(ownerId, "attachment owner")
      return options.withMutationLease(rolloutId, async () => {
        const ownerDirectory = fileNameForId(ownerId)
        const copied: UserAttachment[] = []
        const createdPaths: string[] = []
        const rollback = () =>
          Promise.all(
            createdPaths.map((path) => rm(path, { force: true })),
          ).then(() => undefined)
        try {
          for (const [index, attachment] of attachments.entries()) {
            const sourcePath = resolveReference(attachment.file)
            const file = attachmentReference(
              rolloutId,
              "requests",
              ownerDirectory,
              index,
              attachment.mediaType,
            )
            const targetPath = resolveReference(file)
            await requireMatchingAttachmentSlot(targetPath)
            const existing = await inspectStoredAttachmentIfPresent(
              targetPath,
              options.validatePdf,
            )
            if (existing !== undefined)
              requireMatchingAttachmentMetadata(existing, attachment, true)
            const source = await inspectStoredAttachment(
              sourcePath,
              options.validatePdf,
            )
            requireMatchingAttachmentMetadata(source, attachment)
            if (existing === undefined) {
              if (
                await linkOnce(
                  join(root, rolloutId),
                  sourcePath,
                  targetPath,
                  source.sizeBytes,
                )
              ) {
                createdPaths.push(targetPath)
              }
            } else {
              const [sourceBytes, existingBytes] = await Promise.all([
                readFile(sourcePath),
                readFile(targetPath),
              ])
              if (!sourceBytes.equals(existingBytes)) {
                throw new AttachmentConflictError(
                  "A different attachment already exists for this request.",
                )
              }
            }
            copied.push({ ...attachment, file })
          }
          return { attachments: copied, rollback }
        } catch (error) {
          await rollback()
          throw error
        }
      })
    },

    async discardRequestAttachments(rolloutId, ownerId) {
      requireRolloutId(rolloutId)
      requirePathSegment(ownerId, "attachment owner")
      await rm(
        join(
          root,
          rolloutId,
          "files",
          "attachments",
          "requests",
          fileNameForId(ownerId),
        ),
        { recursive: true, force: true },
      )
    },

    async discardDraftAttachments(attachments) {
      await Promise.all(
        attachments.map(async (attachment) => {
          requireDraftAttachment(attachment.file.rolloutId, attachment)
          await rm(resolveReference(attachment.file), { force: true })
        }),
      )
    },

    async saveToolFile(rolloutId, toolCallId, name, bytes) {
      requireRolloutId(rolloutId)
      requirePathSegment(toolCallId, "tool call id")
      requirePathSegment(name, "tool file name")
      return options.withMutationLease(rolloutId, async () => {
        const reference = {
          rolloutId,
          path: posix.join("tools", fileNameForId(toolCallId), name),
        }
        const path = resolveReference(reference)
        await writeOnce(join(root, rolloutId), path, Buffer.from(bytes))
        return { reference, path }
      })
    },

    async read(reference) {
      const path = resolveReference(reference)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile())
          throw new Error("Rollout asset is not a regular file.")
        return await handle.readFile()
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
          throw new Error("Rollout asset is not a regular file.")
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

function requireRolloutId(rolloutId: string): void {
  if (isStorageKey(rolloutId)) return
  throw new Error(`Invalid rollout id ${rolloutId}.`)
}

function attachmentReference(
  rolloutId: string,
  namespace: "staging" | "requests",
  ownerDirectory: string,
  index: number,
  mediaType: UserAttachment["mediaType"],
): RolloutAssetReference {
  return {
    rolloutId,
    path: posix.join(
      "attachments",
      namespace,
      ownerDirectory,
      `${String(index + 1)}${attachmentExtension(mediaType)}`,
    ),
  }
}

function stagingOwnerDirectory(
  root: string,
  rolloutId: string,
  ownerDirectory: string,
): string {
  return join(
    root,
    rolloutId,
    "files",
    "attachments",
    "staging",
    ownerDirectory,
  )
}

type PdfValidator = (bytes: Uint8Array) => Promise<void>

async function inspectAttachmentBytes(
  bytes: Buffer,
  validatePdf: PdfValidator | undefined,
): Promise<{ mediaType: UserAttachment["mediaType"] }> {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
    return inspectImageBytes(bytes)
  if (validatePdf === undefined)
    throw new Error("PDF attachment validation is unavailable.")
  await validatePdf(Uint8Array.from(bytes))
  return { mediaType: "application/pdf" }
}

async function inspectStoredAttachment(
  path: string,
  validatePdf?: PdfValidator,
) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const file = await handle.stat()
    if (!file.isFile())
      throw new Error("Draft attachment must be a non-empty regular file.")
    requireAttachmentSize(file.size)
    const header = Buffer.alloc(Math.min(file.size, MAX_IMAGE_METADATA_BYTES))
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    if (bytesRead !== header.byteLength)
      throw new Error("Attachment changed while its metadata was being read.")
    const bytes =
      header.subarray(0, 5).toString("ascii") === "%PDF-"
        ? await readBoundedAttachment(handle, file.size)
        : header
    return {
      mediaType: (await inspectAttachmentBytes(bytes, validatePdf)).mediaType,
      sizeBytes: file.size,
    }
  } finally {
    await handle.close()
  }
}

async function readBoundedAttachment(
  handle: FileHandle,
  sizeBytes: number,
): Promise<Buffer> {
  requireAttachmentSize(sizeBytes)
  const bytes = Buffer.alloc(sizeBytes)
  let offset = 0
  while (offset < sizeBytes) {
    const read = await handle.read(
      bytes,
      offset,
      Math.min(64 * 1024, sizeBytes - offset),
      offset,
    )
    if (read.bytesRead === 0)
      throw new Error("Attachment changed while being read.")
    offset += read.bytesRead
  }
  const extra = await handle.read(Buffer.alloc(1), 0, 1, sizeBytes)
  if (extra.bytesRead !== 0)
    throw new Error("Attachment changed while being read.")
  return bytes
}

async function inspectStoredAttachmentIfPresent(
  path: string,
  validatePdf?: PdfValidator,
) {
  try {
    return await inspectStoredAttachment(path, validatePdf)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

function requireMatchingAttachmentMetadata(
  stored: Awaited<ReturnType<typeof inspectStoredAttachment>>,
  attachment: UserAttachment,
  conflictOnMismatch = false,
): void {
  if (
    stored.sizeBytes !== attachment.sizeBytes ||
    stored.mediaType !== attachment.mediaType
  ) {
    if (conflictOnMismatch)
      throw new AttachmentConflictError(
        "A different attachment already exists for this request.",
      )
    throw new Error("Draft attachment metadata does not match its file.")
  }
}

function requireAttachmentName(name: string): void {
  if (
    name.length === 0 ||
    Buffer.byteLength(name, "utf8") > 255 ||
    name.includes("\0")
  ) {
    throw new Error("Attachment name is invalid.")
  }
}

function requireDraftAttachment(
  rolloutId: string,
  attachment: UserAttachment,
): void {
  if (
    attachment.file.rolloutId !== rolloutId ||
    !isStagingAttachmentPath(attachment.file.path)
  ) {
    throw new Error("Attachment is not a draft owned by this rollout.")
  }
  requireAttachmentName(attachment.name)
}

function isStagingAttachmentPath(path: string): boolean {
  const segments = path.split("/")
  return (
    segments.length === 4 &&
    segments[0] === "attachments" &&
    segments[1] === "staging" &&
    segments[2] !== "" &&
    segments[3] !== ""
  )
}

function requireAttachmentSize(sizeBytes: number): void {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > ATTACHMENT_FILE_SAFETY_BYTES
  ) {
    throw new Error(
      "Attachment must be a non-empty file within the 50 MB local safety boundary.",
    )
  }
}

async function copyAttachmentSnapshot(input: {
  readonly root: string
  readonly sourcePath: string
  readonly stagingDirectory: string
  readonly validatePdf: PdfValidator | undefined
}) {
  // Open and bound the source before creating a snapshot; copyFile would copy an
  // arbitrarily large file, or a file growing during import, before validation.
  const source = await open(
    input.sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let temporaryPath: string | undefined
  try {
    const file = await source.stat()
    if (!file.isFile()) throw new Error("Attachment must be a regular file.")
    requireAttachmentSize(file.size)
    await ensureDirectoryChain(input.root, input.stagingDirectory)
    temporaryPath = join(
      input.stagingDirectory,
      `.snapshot-${randomUUID()}.tmp`,
    )
    const target = await open(temporaryPath, "wx", 0o600)
    try {
      const chunk = Buffer.alloc(64 * 1024)
      let offset = 0
      while (true) {
        const { bytesRead } = await source.read(
          chunk,
          0,
          chunk.byteLength,
          offset,
        )
        if (bytesRead === 0) break
        requireAttachmentSize(offset + bytesRead)
        await target.writeFile(chunk.subarray(0, bytesRead))
        offset += bytesRead
      }
      await target.sync()
    } finally {
      await target.close()
    }
    const metadata = await inspectStoredAttachment(
      temporaryPath,
      input.validatePdf,
    )
    return { ...metadata, path: temporaryPath }
  } catch (error) {
    if (temporaryPath !== undefined) await rm(temporaryPath, { force: true })
    throw error
  } finally {
    await source.close()
  }
}

// The caller holds the rollout mutation lease. Extensions identify media for
// serving, but an ordered request slot has only one owner regardless of type.
async function requireMatchingAttachmentSlot(path: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dirname(path))
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  const name = basename(path)
  const prefix = `${name.split(".")[0]}.`
  if (
    names.some(
      (existing) =>
        existing !== name &&
        existing.startsWith(prefix) &&
        !existing.endsWith(".tmp"),
    )
  )
    throw new AttachmentConflictError(
      "A different attachment already exists for this request.",
    )
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
      throw new Error("A different rollout asset already exists at this path.")
    }
    const [source, target] = await Promise.all([
      readFile(sourcePath),
      readFile(path),
    ])
    if (!source.equals(target)) {
      throw new AttachmentConflictError(
        "A different attachment already exists for this request.",
      )
    }
    return false
  }
}

async function writeOnce(
  root: string,
  path: string,
  bytes: Buffer,
): Promise<boolean> {
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
      return true
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const existing = await readFile(path)
      if (!existing.equals(bytes)) {
        throw new Error(
          "A different rollout asset already exists at this path.",
        )
      }
      await syncDirectory(directory)
      return false
    }
  } finally {
    await handle?.close()
    await rm(temporaryPath, { force: true })
  }
}

async function ensureDirectoryChain(root: string, target: string) {
  const rootMetadata = await stat(root)
  if (!rootMetadata.isDirectory()) {
    throw new Error("Physical rollout bundle is not a directory.")
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
    throw new Error("Invalid rollout asset path.")
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

function attachmentExtension(mediaType: UserAttachment["mediaType"]): string {
  if (mediaType === "application/pdf") return ".pdf"
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
