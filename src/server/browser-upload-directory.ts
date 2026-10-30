import { lstat, opendir } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import {
  BrowserControlError,
  type BrowserDirectoryUploadRequest,
} from "../protocol/desktop-browser.ts"

export async function inspectUploadDirectory(
  directory: string,
  signal?: AbortSignal,
): Promise<BrowserDirectoryUploadRequest["files"]> {
  const files: BrowserDirectoryUploadRequest["files"] = []
  let entries = 0
  const visit = async (path: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    // Bound traversal cost even for trees containing only empty directories.
    if (depth > 64)
      throw new BrowserControlError(
        "directory_too_large",
        "Directory enumeration exceeds its 64-level traversal safety bound.",
      )
    const children = await opendir(path)
    for await (const child of children) {
      signal?.throwIfAborted()
      if (++entries > 4096)
        throw new BrowserControlError(
          "directory_too_large",
          "Directory enumeration exceeds its 4096-entry traversal safety bound.",
        )
      const childPath = join(path, child.name),
        metadata = await lstat(childPath)
      if (metadata.isDirectory()) await visit(childPath, depth + 1)
      else if (metadata.isFile() && Number.isSafeInteger(metadata.size)) {
        files.push({
          name: child.name,
          size: metadata.size,
          lastModified: Math.trunc(metadata.mtimeMs),
          relativePath: `${basename(directory)}/${relative(directory, childPath)}`,
        })
        if (
          files.length > 256 ||
          Buffer.byteLength(JSON.stringify(files)) > 65536
        )
          throw new BrowserControlError(
            "directory_too_large",
            "Directory selection exceeds its inspection safety bound of 256 files or 64KiB metadata.",
          )
      } else
        throw new BrowserControlError(
          "unsupported_file_type",
          "Directory selection accepts regular files and directories only; symbolic links and device files are refused.",
        )
    }
  }
  try {
    await visit(directory, 0)
    return files
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
        String(cause.code),
      )
    )
      throw cause
    throw new BrowserControlError(
      "file_unavailable",
      "The selected directory changed or is no longer readable.",
      { cause },
    )
  }
}
