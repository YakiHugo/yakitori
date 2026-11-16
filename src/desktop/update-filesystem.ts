import { execFile } from "node:child_process"
import { isAbsolute, parse, resolve } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

export async function removeUpdateDirectory(directory: string): Promise<void> {
  if (
    !isAbsolute(directory) ||
    resolve(directory) === parse(resolve(directory)).root
  )
    throw new Error(
      "Update cleanup requires an absolute directory below the filesystem root.",
    )
  // Electron exposes .asar files as virtual directories to fs.lstat. Recursive
  // fs.rm can consequently leave the archive behind and fail with ENOTEMPTY.
  // A native filesystem operation removes the actual bundle files.
  await execute("/bin/rm", ["-rf", "--", directory])
}
