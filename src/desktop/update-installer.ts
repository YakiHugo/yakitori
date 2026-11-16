import { execFile } from "node:child_process"
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { removeUpdateDirectory } from "./update-filesystem.ts"

const exec = promisify(execFile)

export type DesktopUpdateInstallerConfig = {
  parentPid: number
  preparedAppPath: string
  targetAppPath: string
  logPath?: string
  relaunchArgs?: string[]
  cleanupDirectory?: string
  resultPath?: string
}

async function run(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await exec(command, args, {
      maxBuffer: 4 * 1024 * 1024,
      ...(env ? { env } : {}),
    })
  } catch (error) {
    throw new Error(
      `${command} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function waitForAuthorizedParentExit(parentPid: number): Promise<void> {
  if (!process.send || !process.connected)
    return Promise.reject(new Error("Update installer requires parent IPC."))
  return new Promise((resolveWait, reject) => {
    let authorized = false
    let armed = false
    const dispose = () => {
      clearInterval(poll)
      process.off("message", onMessage)
      process.off("disconnect", onDisconnect)
    }
    const fail = (error: Error) => {
      dispose()
      reject(error)
    }
    const checkParent = () => {
      try {
        process.kill(parentPid, 0)
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        ) {
          fail(error instanceof Error ? error : new Error(String(error)))
          return
        }
        // Authorization alone is insufficient: the acknowledgement must have
        // reached IPC before a disappearing parent permits replacement.
        if (armed) {
          dispose()
          resolveWait()
        }
      }
    }
    const send = (type: string, sent?: () => void) => {
      try {
        process.send?.({ type }, (error: Error | null) => {
          if (error) fail(error)
          else sent?.()
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
    function onMessage(message: unknown) {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "update-installer-install" ||
        authorized
      )
        return
      authorized = true
      send("update-installer-armed", () => {
        armed = true
        checkParent()
      })
    }
    function onDisconnect() {
      if (!authorized)
        fail(
          new Error("Desktop parent disconnected before authorizing install."),
        )
    }
    process.on("message", onMessage)
    process.on("disconnect", onDisconnect)
    const poll = setInterval(checkParent, 100)
    send("update-installer-ready")
    checkParent()
  })
}

async function validateApp(
  appPath: string,
  verifySignature: boolean,
): Promise<void> {
  if (!(await lstat(appPath)).isDirectory())
    throw new Error("Installer app path must be a directory, not a symlink.")
  const executable = join(appPath, "Contents/MacOS/Yakitori")
  const file = await lstat(executable)
  if (!file.isFile() || !(file.mode & 0o111))
    throw new Error("Installer app executable is missing or not executable.")
  const { stdout } = await exec("/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    join(appPath, "Contents/Info.plist"),
  ]).catch((error: unknown) => {
    throw new Error("Could not read installer app bundle identifier.", {
      cause: error,
    })
  })
  if (stdout.trim() !== "com.yakitori.app")
    throw new Error(
      "Installer app must have bundle identifier com.yakitori.app.",
    )
  if (verifySignature)
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath])
}

export async function runDesktopUpdateInstaller(
  configPath: string,
): Promise<void> {
  if (!isAbsolute(configPath))
    throw new Error("Installer config path must be absolute.")
  const config: unknown = JSON.parse(await readFile(configPath, "utf8"))
  if (
    typeof config !== "object" ||
    config === null ||
    !("parentPid" in config) ||
    typeof config.parentPid !== "number" ||
    !Number.isSafeInteger(config.parentPid) ||
    config.parentPid <= 1 ||
    config.parentPid === process.pid ||
    config.parentPid !== process.ppid ||
    !("preparedAppPath" in config) ||
    typeof config.preparedAppPath !== "string" ||
    !("targetAppPath" in config) ||
    typeof config.targetAppPath !== "string"
  )
    throw new Error("Invalid installer config.")
  const { parentPid, preparedAppPath, targetAppPath } = config
  for (const path of [preparedAppPath, targetAppPath]) {
    if (!isAbsolute(path) || resolve(path) !== path || !path.endsWith(".app"))
      throw new Error(
        "Installer app paths must be absolute canonical .app paths.",
      )
    if ((await realpath(path)) !== path)
      throw new Error("Installer app paths must not contain symlinks.")
  }
  if (
    preparedAppPath === targetAppPath ||
    preparedAppPath.startsWith(`${targetAppPath}${sep}`) ||
    targetAppPath.startsWith(`${preparedAppPath}${sep}`)
  )
    throw new Error("Prepared and target apps must be separate directories.")
  const logPath = "logPath" in config ? config.logPath : undefined
  if (
    logPath !== undefined &&
    (typeof logPath !== "string" || !isAbsolute(logPath))
  )
    throw new Error("Installer log path must be absolute.")
  const relaunchArgs = "relaunchArgs" in config ? config.relaunchArgs : []
  if (
    !Array.isArray(relaunchArgs) ||
    relaunchArgs.some(
      (value: unknown) => typeof value !== "string" || value.includes("\0"),
    )
  )
    throw new Error("Invalid installer relaunch arguments.")
  const cleanupDirectory =
    "cleanupDirectory" in config ? config.cleanupDirectory : undefined
  if (cleanupDirectory !== undefined) {
    if (
      typeof cleanupDirectory !== "string" ||
      !isAbsolute(cleanupDirectory) ||
      (await realpath(cleanupDirectory)) !== cleanupDirectory ||
      dirname(configPath) !== cleanupDirectory ||
      !preparedAppPath.startsWith(`${cleanupDirectory}${sep}`) ||
      !(await realpath(process.execPath)).startsWith(
        `${cleanupDirectory}${sep}`,
      ) ||
      targetAppPath === cleanupDirectory ||
      targetAppPath.startsWith(`${cleanupDirectory}${sep}`) ||
      cleanupDirectory.startsWith(`${targetAppPath}${sep}`)
    )
      throw new Error(
        "Installer cleanup directory must own its config, prepared app and runtime outside the target.",
      )
  }
  const resultPath = "resultPath" in config ? config.resultPath : undefined
  if (
    resultPath !== undefined &&
    (typeof resultPath !== "string" ||
      !isAbsolute(resultPath) ||
      resolve(resultPath) !== resultPath ||
      [preparedAppPath, targetAppPath, cleanupDirectory].some(
        (directory) =>
          typeof directory === "string" &&
          (resultPath === directory ||
            resultPath.startsWith(`${directory}${sep}`)),
      ))
  )
    throw new Error(
      "Installer result path must be absolute and outside app and cleanup directories.",
    )
  const log = async (message: string) => {
    if (typeof logPath === "string") {
      try {
        await appendFile(logPath, `${message}\n`)
      } catch (error) {
        console.error("Could not write installer log:", error)
      }
    } else console.log(message)
  }
  const persistResult = async (
    result: { status: "installed" } | { status: "failed"; message: string },
  ) => {
    if (typeof resultPath !== "string") return
    try {
      await writeFile(resultPath, JSON.stringify(result), { mode: 0o600 })
    } catch (error) {
      await log(
        `Could not persist installer result: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // LaunchServices inherits open's environment. The detached worker's Node
  // mode and IPC channel belong to this process, never to the restarted GUI.
  const launchEnvironment = { ...process.env }
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "NODE_UNIQUE_ID",
  ])
    delete launchEnvironment[name]
  // Attach the disconnect observer before asynchronous bundle validation.
  let disconnected = !process.connected
  const rememberDisconnect = () => {
    disconnected = true
  }
  process.on("disconnect", rememberDisconnect)
  try {
    await validateApp(preparedAppPath, true)
    await validateApp(targetAppPath, false)
    if (disconnected)
      throw new Error("Desktop parent disconnected before authorizing install.")
    await waitForAuthorizedParentExit(parentPid)
  } finally {
    process.off("disconnect", rememberDisconnect)
  }
  let replacement: string | undefined
  let backup = ""
  let backedUp = false
  let installed = false
  let keepBackup = false
  try {
    await log("Parent exited; installing prepared update.")
    replacement = await mkdtemp(
      join(dirname(targetAppPath), `.${basename(targetAppPath)}-install-`),
    )
    const copied = join(replacement, "prepared.app")
    backup = join(replacement, "previous.app")
    await run("/usr/bin/ditto", [preparedAppPath, copied])
    await validateApp(copied, true)
    await rename(targetAppPath, backup)
    backedUp = true
    await rename(copied, targetAppPath)
    installed = true
    await validateApp(targetAppPath, true)
    await persistResult({ status: "installed" })
    await run(
      "/usr/bin/open",
      [
        "-n",
        targetAppPath,
        ...(relaunchArgs.length ? ["--args", ...relaunchArgs] : []),
      ],
      launchEnvironment,
    )
    await log(`Installed and launched ${targetAppPath}.`)
  } catch (error) {
    if (backedUp) {
      try {
        if (installed) await removeUpdateDirectory(targetAppPath)
        await rename(backup, targetAppPath)
      } catch (restoreError) {
        keepBackup = true
        const failure = new AggregateError(
          [error, restoreError],
          `Update failed; previous app remains at ${backup}.`,
        )
        await persistResult({ status: "failed", message: failure.message })
        throw failure
      }
    }
    await log(
      `Update failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    await persistResult({
      status: "failed",
      message:
        (error instanceof Error ? error.message : String(error))
          .split("\n")[0]
          ?.slice(0, 1000) ?? "Update installation failed.",
    })
    try {
      await run(
        "/usr/bin/open",
        [
          "-n",
          targetAppPath,
          ...(relaunchArgs.length ? ["--args", ...relaunchArgs] : []),
        ],
        launchEnvironment,
      )
    } catch (relaunchError) {
      await log(
        `Could not reopen previous app: ${relaunchError instanceof Error ? relaunchError.message : String(relaunchError)}`,
      )
    }
    throw error
  } finally {
    const cleanup: Promise<void>[] = []
    if (!keepBackup && replacement)
      cleanup.push(removeUpdateDirectory(replacement))
    if (typeof cleanupDirectory === "string")
      cleanup.push(removeUpdateDirectory(cleanupDirectory))
    for (const result of await Promise.allSettled(cleanup)) {
      if (result.status === "rejected")
        console.error(
          "Could not clean completed update staging:",
          result.reason,
        )
    }
  }
}

if (process.argv[2] === "--desktop-update-install") {
  try {
    const configPath = process.argv[3]
    if (!configPath) throw new Error("Installer config path is required.")
    await runDesktopUpdateInstaller(configPath)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    if (process.connected) process.disconnect?.()
  }
}
