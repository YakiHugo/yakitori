import { open, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type InstructionPrefix = Readonly<{
  text: string
  truncated: boolean
  byteCount: number
}>

export type InstructionDiagnostic = Readonly<{ path: string; message: string }>

export function instructionHome(): string {
  return process.env.YAKITORI_HOME ?? join(homedir(), ".yakitori")
}

export function isFileSystemError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z]+$/.test(error.code)
  )
}

export async function fileSignature(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    return info.isFile()
      ? `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
      : undefined
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  let end = Math.max(0, Math.min(maxBytes, bytes.length))
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80)
    end--
  return bytes.subarray(0, end).toString("utf8")
}

export async function readInstructionPrefix(
  path: string,
  maxBytes: number,
): Promise<InstructionPrefix> {
  const file = await open(path, "r")
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        used,
      )
      if (bytesRead === 0) break
      used += bytesRead
    }
    let end = Math.min(used, maxBytes)
    while (end > 0 && end < used && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--
    return {
      text: buffer.subarray(0, end).toString("utf8"),
      truncated: used > maxBytes,
      byteCount: Math.min(used, maxBytes),
    }
  } finally {
    await file.close()
  }
}

export async function instructionDirectories(
  cwd: string,
  markers: readonly string[] = [".git"],
  explicitRoot?: string,
): Promise<string[]> {
  const directory = await realpath(cwd)
  const root =
    explicitRoot === undefined ? undefined : await realpath(explicitRoot)
  const directories: string[] = []
  let current = directory
  for (;;) {
    directories.push(current)
    if (root === current) return directories.reverse()
    if (root === undefined) {
      for (const marker of markers) {
        try {
          await stat(join(current, marker))
          return directories.reverse()
        } catch (error) {
          // Markers are discovery hints. An unreadable marker must not prevent
          // checking the remaining markers or ancestors.
          if (!isFileSystemError(error)) throw error
        }
      }
      if (markers.length === 0) return [directory]
    }
    const parent = dirname(current)
    if (parent === current) {
      if (root !== undefined)
        throw new Error(
          `Working directory is outside instruction root: ${directory}`,
        )
      return [directory]
    }
    current = parent
  }
}
