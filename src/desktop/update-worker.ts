import { type ChildProcess, execFile, spawn } from "node:child_process"
import { open, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { removeUpdateDirectory } from "./update-filesystem.ts"

// This bounds local IPC failures, not the time allowed for Turns to finish.
const installerHandshakeTimeoutMs = 10_000
const execute = promisify(execFile)

export type UpdateInstallerHandle = Readonly<{
  arm(): Promise<void>
  cancel(): Promise<void>
}>

export async function startUpdateInstaller(
  options: Readonly<{
    applicationPath: string
    preparedAppPath: string
    directory: string
    userDataPath: string
    logPath: string
  }>,
): Promise<UpdateInstallerHandle> {
  // The installed runtime is about to be replaced. The worker runs from its
  // own clone, including Electron's frameworks and unpacked script bundle.
  const runtime = path.join(options.directory, "runtime", "Yakitori.app")
  await removeUpdateDirectory(path.dirname(runtime))
  // Electron's fs treats ASAR archives as virtual directories. Native copying
  // preserves the archive bytes and uses APFS clones when available.
  await execute("/usr/bin/ditto", ["--clone", options.applicationPath, runtime])
  const configPath = path.join(options.directory, "installer.json")
  await writeFile(
    configPath,
    JSON.stringify({
      parentPid: process.pid,
      preparedAppPath: options.preparedAppPath,
      targetAppPath: options.applicationPath,
      relaunchArgs: [`--user-data-dir=${options.userDataPath}`],
      logPath: options.logPath,
      resultPath: path.join(
        path.dirname(options.logPath),
        "update-result.json",
      ),
      cleanupDirectory: options.directory,
    }),
    { mode: 0o600 },
  )
  await writeFile(
    options.logPath,
    `Starting application update ${new Date().toISOString()}\n`,
  )
  const log = await open(options.logPath, "a")
  let child: ChildProcess | undefined
  let failure: Error | undefined
  let ready: (() => void) | undefined
  let armed: (() => void) | undefined
  let failed: ((error: Error) => void) | undefined
  let readyTimeout: ReturnType<typeof setTimeout> | undefined
  let installationAuthorized = false
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve
    failed = reject
  })
  try {
    child = spawn(
      path.join(runtime, "Contents", "MacOS", "Yakitori"),
      [
        path.join(
          runtime,
          "Contents",
          "Resources",
          "app.asar.unpacked",
          "dist",
          "desktop",
          "update-installer.js",
        ),
        "--desktop-update-install",
        configPath,
      ],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd, "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    )
    child.on("message", (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message)
      )
        return
      if (message.type === "update-installer-ready") {
        clearTimeout(readyTimeout)
        ready?.()
      } else if (message.type === "update-installer-armed") {
        armed?.()
      }
    })
    const fail = (error: Error) => {
      failure = error
      clearTimeout(readyTimeout)
      failed?.(error)
    }
    child.once("error", fail)
    child.once("exit", (code, signal) => {
      fail(
        new Error(
          `The update installer stopped (${signal ?? code ?? "unknown"}).`,
        ),
      )
    })
    readyTimeout = setTimeout(() => {
      child?.kill()
      fail(new Error("The update installer did not start. Try again."))
    }, installerHandshakeTimeoutMs)
    child.unref()
    child.channel?.unref()
  } finally {
    await log.close()
  }
  await readyPromise
  failed = undefined
  const worker = child
  if (worker === undefined)
    throw new Error("The update installer was not started.")
  return {
    arm() {
      if (failure !== undefined) return Promise.reject(failure)
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error("The update installer did not acknowledge shutdown."),
            ),
          installerHandshakeTimeoutMs,
        )
        armed = () => {
          clearTimeout(timeout)
          failed = undefined
          resolve()
        }
        failed = (error) => {
          clearTimeout(timeout)
          reject(error)
        }
        worker.send({ type: "update-installer-install" }, (error) => {
          if (error !== null) failed?.(error)
        })
        installationAuthorized = true
      })
    },
    async cancel() {
      if (installationAuthorized)
        throw new Error("An authorized installation cannot be canceled.")
      if (worker.exitCode === null && worker.signalCode === null) {
        await new Promise<void>((resolveExit) => {
          worker.once("exit", () => resolveExit())
          worker.kill()
        })
      }
      try {
        await removeUpdateDirectory(path.dirname(runtime))
      } catch (error) {
        // The unarmed worker has stopped. Cleanup must not prevent the user
        // from keeping the current window and retrying the prepared update.
        console.error("Could not remove canceled update runtime:", error)
      }
    },
  }
}
