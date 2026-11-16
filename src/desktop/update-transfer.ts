import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  type DesktopUpdateArchive,
  type DesktopUpdateChunk,
  parseDesktopUpdateChunks,
} from "./update-release.ts"

export type DesktopUpdateTransferStats = {
  /** Archive content supplied by HTTP bodies or inline manifest metadata,
   * excluding bytes discarded when a full response restarts reconstruction. */
  downloadedBytes: number
  reusedBytes: number
  totalBytes: number
}

export type DesktopUpdateTransferOptions = {
  archive: DesktopUpdateArchive
  destination: string
  cacheDirectory: string
  installedAppPath?: string
  fetch?: typeof fetch
  signal?: AbortSignal
  onProgress?: (progress: DesktopUpdateTransferStats) => void
}

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
const cacheName = (chunk: DesktopUpdateChunk) =>
  `${chunk.sha256}-${chunk.size}.chunk`
const ownedCacheFile = /^(?:[a-f0-9]{64}-[1-9]\d*\.chunk|\.write-[a-f0-9-]+)$/

function unavailableFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(
      String(error.code),
    )
  )
}

async function readChunk(
  path: string,
  chunk: DesktopUpdateChunk,
  offset: number,
  exactSize: boolean,
): Promise<Buffer | undefined> {
  let file: FileHandle
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (unavailableFile(error)) return undefined
    throw error
  }
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size < offset + chunk.size ||
      (exactSize && stat.size !== chunk.size)
    )
      return undefined
    const bytes = Buffer.alloc(chunk.size)
    let received = 0
    while (received < bytes.length) {
      const result = await file.read(
        bytes,
        received,
        bytes.length - received,
        offset + received,
      )
      if (!result.bytesRead) return undefined
      received += result.bytesRead
    }
    return hash(bytes) === chunk.sha256 ? bytes : undefined
  } finally {
    await file.close()
  }
}

async function installedChunk(
  installed: string | undefined,
  chunk: DesktopUpdateChunk,
): Promise<Buffer | undefined> {
  if (!installed || !chunk.sourcePath || chunk.sourceOffset === undefined)
    return undefined
  // Refuse every symlink component, including internal framework aliases. Tar
  // payloads use the concrete regular path too; missing/modified files download.
  let path = installed
  try {
    const parts = chunk.sourcePath.split("/")
    for (const [index, part] of parts.entries()) {
      path = join(path, part)
      const stat = await lstat(path)
      if (
        stat.isSymbolicLink() ||
        (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
      )
        return undefined
    }
    return await readChunk(path, chunk, chunk.sourceOffset, false)
  } catch (error) {
    if (unavailableFile(error)) return undefined
    throw error
  }
}

async function writeAt(file: FileHandle, bytes: Uint8Array, offset: number) {
  let written = 0
  while (written < bytes.length) {
    const result = await file.write(
      bytes,
      written,
      bytes.length - written,
      offset + written,
    )
    if (!result.bytesWritten)
      throw new Error("Update archive write made no progress.")
    written += result.bytesWritten
  }
}

async function receive(
  response: Response,
  size: number,
  signal: AbortSignal | undefined,
  consume: (bytes: Uint8Array, offset: number) => Promise<void>,
) {
  const declared = response.headers.get("content-length")
  const encoding = response.headers.get("content-encoding")
  if (
    (declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) !== size)) ||
    (encoding !== null && encoding !== "identity")
  ) {
    await response.body?.cancel()
    throw new Error(
      "Update response size does not match its published size or encoding is invalid.",
    )
  }
  if (!response.body) throw new Error("Update response body is missing.")
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", cancel, { once: true })
  let offset = 0
  try {
    signal?.throwIfAborted()
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      if (offset + value.length > size)
        throw new Error("Update response exceeds its published size.")
      await consume(value, offset)
      offset += value.length
    }
    if (offset !== size)
      throw new Error("Update integrity check failed: response is truncated.")
  } finally {
    signal?.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * Reconstruct the exact release tar, authenticating each reused/downloaded chunk
 * and the final archive. Only a complete verified archive replaces destination.
 * The caller must obtain archive metadata through trusted release discovery.
 */
export async function downloadDesktopUpdate({
  archive,
  destination,
  cacheDirectory,
  installedAppPath,
  fetch: request = fetch,
  signal,
  onProgress,
}: DesktopUpdateTransferOptions): Promise<DesktopUpdateTransferStats> {
  if (
    !Number.isSafeInteger(archive.size) ||
    archive.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(archive.sha256)
  )
    throw new Error("Desktop update archive size or SHA256 is invalid.")
  const chunks =
    archive.chunks === undefined
      ? undefined
      : parseDesktopUpdateChunks(archive.chunks, archive.size)
  signal?.throwIfAborted()
  // This child is exclusively owned by this module; never prune the caller's
  // cache directory or recursively remove unknown entries.
  const cache = join(cacheDirectory, "desktop-update-chunks-v1")
  if (chunks) {
    await mkdir(cache, { recursive: true, mode: 0o700 })
    const cacheStat = await lstat(cache)
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink())
      throw new Error("Update chunk cache must be a real directory.")
    const required = new Set(
      chunks.filter((chunk) => chunk.data === undefined).map(cacheName),
    )
    for (const entry of await readdir(cache, { withFileTypes: true })) {
      if (
        !entry.isDirectory() &&
        ownedCacheFile.test(entry.name) &&
        !required.has(entry.name)
      )
        await rm(join(cache, entry.name), { force: true })
    }
  }
  let installed: string | undefined
  if (installedAppPath) {
    try {
      installed = await realpath(installedAppPath)
    } catch (error) {
      if (!unavailableFile(error)) throw error
    }
  }
  const stats = { downloadedBytes: 0, reusedBytes: 0, totalBytes: archive.size }
  const report = () => onProgress?.({ ...stats })
  const saveCache = async (chunk: DesktopUpdateChunk, bytes: Buffer) => {
    signal?.throwIfAborted()
    const temporary = join(cache, `.write-${randomUUID()}`)
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
      signal?.throwIfAborted()
      await rename(temporary, join(cache, cacheName(chunk)))
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const target = resolve(destination)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = join(
    dirname(target),
    `.desktop-update-${randomUUID()}.partial`,
  )
  const file = await open(temporary, "wx+", 0o600)
  let closed = false
  try {
    report()
    let fullResponse: Response | undefined
    if (chunks) {
      for (const chunk of chunks) {
        signal?.throwIfAborted()
        if (chunk.data !== undefined) {
          // Parsing authenticated the canonical encoding, size and digest.
          // These bytes already arrived in discovery; no cache I/O or range.
          const inline = Buffer.from(chunk.data, "base64")
          await writeAt(file, inline, chunk.offset)
          stats.downloadedBytes += inline.length
          report()
          continue
        }
        const cachedPath = join(cache, cacheName(chunk))
        let bytes = await readChunk(cachedPath, chunk, 0, true)
        const cached = bytes !== undefined
        if (!bytes) {
          // Unverified cache entries are disposable. A network digest failure,
          // in contrast, must fail visibly rather than silently retry.
          const entry = await lstat(cachedPath).catch((error: unknown) => {
            if (unavailableFile(error)) return undefined
            throw error
          })
          if (entry && !entry.isDirectory())
            await rm(cachedPath, { force: true })
          bytes = await installedChunk(installed, chunk)
        }
        if (bytes) {
          await writeAt(file, bytes, chunk.offset)
          if (!cached) await saveCache(chunk, bytes)
          stats.reusedBytes += bytes.length
          report()
          continue
        }
        const response = await request(archive.url, {
          headers: {
            Accept: "application/octet-stream",
            "Accept-Encoding": "identity",
            Range: `bytes=${chunk.offset}-${chunk.offset + chunk.size - 1}`,
          },
          ...(signal ? { signal } : {}),
        })
        if (response.status === 200) {
          fullResponse = response
          break
        }
        if (
          response.status !== 206 ||
          response.headers.get("content-range") !==
            `bytes ${chunk.offset}-${chunk.offset + chunk.size - 1}/${archive.size}`
        ) {
          await response.body?.cancel()
          throw new Error(
            `Update range response is invalid (HTTP ${response.status}).`,
          )
        }
        const downloaded = Buffer.alloc(chunk.size)
        await receive(response, chunk.size, signal, async (part, offset) => {
          downloaded.set(part, offset)
          stats.downloadedBytes += part.length
          report()
        })
        if (hash(downloaded) !== chunk.sha256)
          throw new Error("Update chunk failed SHA256 verification.")
        await writeAt(file, downloaded, chunk.offset)
        await saveCache(chunk, downloaded)
      }
    } else {
      fullResponse = await request(archive.url, {
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
        },
        ...(signal ? { signal } : {}),
      })
    }
    if (fullResponse) {
      if (fullResponse.status !== 200) {
        await fullResponse.body?.cancel()
        throw new Error(
          `Could not download the update (HTTP ${fullResponse.status}).`,
        )
      }
      // A server ignoring Range gets one complete download, never one per chunk.
      stats.downloadedBytes = 0
      stats.reusedBytes = 0
      await file.truncate(0)
      await receive(
        fullResponse,
        archive.size,
        signal,
        async (part, offset) => {
          await writeAt(file, part, offset)
          stats.downloadedBytes += part.length
          report()
        },
      )
    }
    signal?.throwIfAborted()
    const digest = createHash("sha256")
    const buffer = Buffer.alloc(1024 * 1024)
    for (let offset = 0; offset < archive.size; ) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, archive.size - offset),
        offset,
      )
      if (!bytesRead)
        throw new Error("Reconstructed update archive is truncated.")
      digest.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
      signal?.throwIfAborted()
    }
    if (digest.digest("hex") !== archive.sha256)
      throw new Error("Update archive failed SHA256 integrity check.")
    if (fullResponse && chunks) {
      for (const chunk of chunks) {
        signal?.throwIfAborted()
        const bytes = Buffer.alloc(chunk.size)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(
            bytes,
            offset,
            bytes.length - offset,
            chunk.offset + offset,
          )
          if (!bytesRead)
            throw new Error("Reconstructed update chunk is truncated.")
          offset += bytesRead
        }
        if (hash(bytes) !== chunk.sha256)
          throw new Error("Update chunk failed SHA256 verification.")
        if (chunk.data === undefined) await saveCache(chunk, bytes)
      }
    }
    await file.close()
    closed = true
    signal?.throwIfAborted()
    await rename(temporary, target)
    report()
    return { ...stats }
  } finally {
    if (!closed) await file.close()
    await rm(temporary, { force: true })
  }
}
