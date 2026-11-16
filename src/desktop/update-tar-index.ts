import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import {
  type DesktopUpdateChunk,
  desktopUpdateChunkCountLimit,
  desktopUpdateChunkSizeLimit,
  safeDesktopUpdateSourcePath,
} from "./update-release.ts"

/**
 * Index the actual tar bytes, preserving headers, PAX records, padding and end
 * markers. Only regular file payloads with a known path can reuse installed data.
 * Extraction security remains owned by prepareDesktopUpdate's tar validator.
 */
export async function indexDesktopUpdateTar(
  archivePath: string,
): Promise<DesktopUpdateChunk[]> {
  const archive = await open(archivePath, "r")
  try {
    const size = (await archive.stat()).size
    const chunks: DesktopUpdateChunk[] = []
    const read = async (offset: number, size: number) => {
      const bytes = Buffer.alloc(size)
      let received = 0
      while (received < size) {
        const result = await archive.read(
          bytes,
          received,
          size - received,
          offset + received,
        )
        if (!result.bytesRead) throw new Error("Truncated tar archive.")
        received += result.bytesRead
      }
      return bytes
    }
    const append = async (
      start: number,
      end: number,
      sourcePath?: string,
      inline = false,
    ) => {
      for (
        let offset = start;
        offset < end;
        offset += desktopUpdateChunkSizeLimit
      ) {
        if (chunks.length >= desktopUpdateChunkCountLimit)
          throw new Error("Tar chunk count exceeds its safety boundary.")
        const length = Math.min(desktopUpdateChunkSizeLimit, end - offset)
        const bytes = await read(offset, length)
        chunks.push({
          offset,
          size: length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ...(sourcePath ? { sourcePath, sourceOffset: offset - start } : {}),
          ...(inline ? { data: bytes.toString("base64") } : {}),
        })
      }
    }
    const text = (bytes: Buffer) =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const field = (bytes: Buffer) =>
      text(
        bytes.subarray(0, bytes.indexOf(0) < 0 ? undefined : bytes.indexOf(0)),
      )
    const number = (bytes: Buffer) => {
      const value = field(bytes).trim()
      if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field.")
      const parsed = Number.parseInt(value, 8)
      if (!Number.isSafeInteger(parsed))
        throw new Error("Oversized tar member.")
      return parsed
    }
    let offset = 0
    let metadataStart = 0
    let extended: Record<string, string> = {}
    const global: Record<string, string> = {}
    let longName: string | undefined
    let headers = 0
    while (offset + 512 <= size) {
      if (++headers > 500_000) throw new Error("Too many tar headers.")
      const header = await read(offset, 512)
      if (header.every((byte) => byte === 0)) {
        await append(metadataStart, size, undefined, true)
        return chunks
      }
      const checksum = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      )
      if (checksum !== number(header.subarray(148, 156)))
        throw new Error("Invalid tar header checksum.")
      const length = number(header.subarray(124, 136))
      const end = offset + 512 + Math.ceil(length / 512) * 512
      if (!Number.isSafeInteger(end) || end > size)
        throw new Error("Truncated tar member.")
      const type = String.fromCharCode(header[156] || 48)
      if (type === "x" || type === "g" || type === "L" || type === "K") {
        // Match the preparer's metadata RAM boundary.
        if (length > 1024 * 1024)
          throw new Error("Tar metadata exceeds its safety boundary.")
        const payload = await read(offset + 512, length)
        if (type === "L") longName = field(payload).replace(/\n$/, "")
        else if (type !== "K") {
          const attributes = type === "g" ? global : extended
          let cursor = 0
          while (cursor < payload.length) {
            const space = payload.indexOf(32, cursor)
            const digits = payload.subarray(cursor, space).toString("ascii")
            const recordSize = Number(digits)
            if (
              space < cursor ||
              !/^[1-9]\d*$/.test(digits) ||
              !Number.isSafeInteger(recordSize) ||
              recordSize <= space - cursor + 2 ||
              cursor + recordSize > payload.length ||
              payload[cursor + recordSize - 1] !== 10
            )
              throw new Error("Invalid PAX record.")
            const record = payload.subarray(space + 1, cursor + recordSize - 1)
            const equal = record.indexOf(61)
            if (equal < 1) throw new Error("Invalid PAX attribute.")
            const key = text(record.subarray(0, equal))
            if (key.toLowerCase().includes("sparse"))
              throw new Error("Sparse tar members are unsupported.")
            if (key === "path" || key === "size")
              attributes[key] = text(record.subarray(equal + 1))
            cursor += recordSize
          }
        }
      } else {
        const attributes = { ...global, ...extended }
        if (attributes.size !== undefined && attributes.size !== String(length))
          throw new Error("Tar size overrides are unsupported.")
        const name =
          attributes.path ??
          longName ??
          [field(header.subarray(345, 500)), field(header.subarray(0, 100))]
            .filter(Boolean)
            .join("/")
        const normalized = name.replace(/^\.\//, "")
        const sourcePath = normalized.startsWith("Yakitori.app/")
          ? normalized.slice("Yakitori.app/".length)
          : undefined
        if (length > 0) {
          await append(metadataStart, offset + 512, undefined, true)
          const regularPath =
            type === "0" &&
            sourcePath &&
            safeDesktopUpdateSourcePath(sourcePath)
              ? sourcePath
              : undefined
          // Unknown or unsafe payload mappings stay network chunks; embedding
          // arbitrary file contents would turn the manifest into another archive.
          await append(offset + 512, offset + 512 + length, regularPath)
          metadataStart = offset + 512 + length
        }
        extended = {}
        longName = undefined
      }
      offset = end
    }
    throw new Error("Tar archive has no end marker.")
  } finally {
    await archive.close()
  }
}
