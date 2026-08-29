import { spawn } from "node:child_process"

let packagingError: unknown
try {
  await run("pnpm", ["exec", "electron-rebuild", "--force", "--only", "fs-ext"])
  await run("pnpm", ["exec", "electron-builder"])
  await run(process.execPath, ["scripts/verify-packaged-runtime.ts"])
} catch (error) {
  packagingError = error
}

try {
  // electron-rebuild mutates the workspace addon. Restore the ABI used by the
  // ordinary Node runtime so tests and the development server still work.
  await run("pnpm", ["rebuild", "fs-ext"])
} catch (restoreError) {
  if (packagingError !== undefined) {
    throw new AggregateError(
      [packagingError, restoreError],
      "Desktop packaging and native dependency restoration failed.",
    )
  }
  throw restoreError
}

if (packagingError !== undefined) throw packagingError

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${signal ?? code ?? "unknown"}).`,
          ),
        )
      }
    })
  })
}
