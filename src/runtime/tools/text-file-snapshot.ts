import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { decodeTextFile } from "./text-file-format.ts"
import type { ToolFailure } from "./types.ts"

export const regularFileReadFlags =
  constants.O_RDONLY |
  (process.platform === "win32"
    ? 0
    : constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))

export async function readTextFileSnapshot(
  absolutePath: string,
  displayPath: string,
  maxBytes: number,
): Promise<{ ok: true; content: string; sha256: string } | ToolFailure> {
  const snapshot = await readRegularFileSnapshot(
    absolutePath,
    displayPath,
    maxBytes,
  )
  if (!snapshot.ok) return snapshot
  const content = decodeTextFile(snapshot.bytes)
  if (content === undefined) {
    return snapshotFailure(
      "unsupported_text_encoding",
      `${displayPath} is not supported UTF-8 text.`,
    )
  }
  return { ok: true, content, sha256: snapshot.sha256 }
}

export async function readRegularFileSnapshot(
  absolutePath: string,
  displayPath: string,
  maxBytes: number,
): Promise<{ ok: true; bytes: Buffer; sha256: string } | ToolFailure> {
  try {
    const handle = await open(absolutePath, regularFileReadFlags)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) {
        return snapshotFailure(
          "unsupported_file_type",
          `${displayPath} must be a regular file.`,
        )
      }
      if (before.size > maxBytes) {
        return snapshotFailure(
          "content_too_large",
          `${displayPath} exceeds ${maxBytes} bytes.`,
        )
      }
      const bytes = Buffer.alloc(Number(before.size) + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          length,
          bytes.length - length,
          length,
        )
        if (bytesRead === 0) break
        length += bytesRead
      }
      const after = await handle.stat({ bigint: true })
      if (
        BigInt(length) !== before.size ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        return snapshotFailure(
          "file_changed_during_read",
          `${displayPath} changed while being read.`,
        )
      }
      const snapshot = bytes.subarray(0, length)
      return {
        ok: true,
        bytes: snapshot,
        sha256: createHash("sha256").update(snapshot).digest("hex"),
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error)) throw error
    return snapshotFailure(
      "read_failed",
      `Could not read ${displayPath} safely.`,
    )
  }
}

function snapshotFailure(code: string, message: string): ToolFailure {
  return { ok: false, code, message, content: `${code}: ${message}` }
}
