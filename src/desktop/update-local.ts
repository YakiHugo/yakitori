import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, type Stats } from "node:fs"
import { lstat, open, readFile, readlink, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import type { DesktopUpdateRelease } from "../protocol/desktop-update.ts"
import { prepareDesktopUpdate } from "./update-preparation.ts"
import { parseDesktopBuildInfo } from "./update-release.ts"

const execute = promisify(execFile)
// Bound Git's filename listing in memory; source contents are streamed.
const gitListingMaxBytes = 16 * 1024 * 1024

export type LocalDesktopUpdate = Readonly<{
  release: DesktopUpdateRelease
  prepare(directory: string, signal: AbortSignal): Promise<{ appPath: string }>
}>

async function snapshot(workspace: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const cancellation = signal === undefined ? {} : { signal }
  const [
    { stdout: repository },
    { stdout: commit },
    { stdout: status },
    listing,
  ] = await Promise.all([
    execute("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      ...cancellation,
    }),
    execute("git", ["rev-parse", "HEAD"], { cwd: workspace, ...cancellation }),
    execute("git", ["status", "--porcelain"], {
      cwd: workspace,
      ...cancellation,
    }),
    execute(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: workspace, maxBuffer: gitListingMaxBytes, ...cancellation },
    ),
  ])
  if ((await realpath(repository.trim())) !== workspace)
    throw new Error("Choose the root of the local Yakitori repository.")
  const hash = createHash("sha256").update(commit.trim())
  for (const name of [
    ...new Set(listing.stdout.split("\0").filter(Boolean)),
  ].sort()) {
    signal?.throwIfAborted()
    hash.update(`\0${name}\0`)
    const file = path.join(workspace, name)
    let stat: Stats
    try {
      stat = await lstat(file)
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        hash.update("deleted")
        continue
      }
      throw error
    }
    hash.update(
      JSON.stringify([
        stat.mode & 0o777,
        stat.isSymbolicLink() ? "link" : "file",
        stat.size,
      ]),
    )
    if (stat.isSymbolicLink()) hash.update(await readlink(file))
    else if (stat.isFile())
      for await (const chunk of createReadStream(file, cancellation))
        hash.update(chunk)
  }
  return {
    commit: commit.trim(),
    dirty: status.length > 0,
    fingerprint: hash.digest("hex"),
  }
}

export async function runLocalPackage(
  workspace: string,
  logPath: string,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  signal.throwIfAborted()
  const log = await open(logPath, "w", 0o600)
  const env = { ...environment }
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "NODE_UNIQUE_ID",
  ])
    delete env[name]
  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      // Interactive login mode loads the same nvm/fnm/pnpm setup as Terminal.
      // The selected path is positional data, never interpolated shell code.
      const child = spawn(
        "/bin/zsh",
        [
          "-lic",
          'cd -- "$1" && exec pnpm package',
          "yakitori-local-update",
          workspace,
        ],
        {
          cwd: workspace,
          detached: true,
          env,
          stdio: ["ignore", log.fd, log.fd],
        },
      )
      let cancellation: Promise<void> | undefined
      let spawned = false
      const kill = (value: NodeJS.Signals) => {
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, value)
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
          )
            throw error
        }
      }
      const groupAlive = () => {
        if (child.pid === undefined) return false
        try {
          process.kill(-child.pid, 0)
          return true
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          )
            return false
          // Darwin can report EPERM for a killed group awaiting zombie
          // reaping. Keep polling; it does not establish disappearance.
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "EPERM"
          )
            return true
          throw error
        }
      }
      const abort = () => {
        if (!spawned || cancellation !== undefined) return
        cancellation = (async () => {
          kill("SIGTERM")
          // A package leader can exit before its compilers. Cancellation owns
          // the whole group, including grandchildren that ignore SIGTERM.
          const deadline = Date.now() + 5000
          while (groupAlive()) {
            if (Date.now() >= deadline) {
              kill("SIGKILL")
              const killedDeadline = Date.now() + 1000
              while (groupAlive() && Date.now() < killedDeadline)
                await delay(25)
              if (groupAlive())
                throw new Error(
                  "The canceled build process group did not stop.",
                )
              break
            }
            await delay(50)
          }
        })()
        // Preserve cleanup failure for finish(), including early child exits.
        void cancellation.catch(() => {})
      }
      child.once("spawn", () => {
        spawned = true
        if (signal.aborted) abort()
      })
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", abort)
        if (cancellation)
          void cancellation.then(() => reject(signal.reason), reject)
        else if (error) reject(error)
        else resolve()
      }
      child.once("error", finish)
      child.once("exit", (code, exitSignal) =>
        finish(
          code === 0
            ? undefined
            : new Error(
                `Local build failed (${exitSignal ?? code}). See ${logPath}`,
              ),
        ),
      )
    })
  } finally {
    await log.close()
  }
}

export async function checkLocalDesktopUpdate(
  options: Readonly<{
    workspace: string
    installedAppPath: string
    logPath: string
    signal?: AbortSignal
  }>,
): Promise<LocalDesktopUpdate> {
  options.signal?.throwIfAborted()
  const workspace = await realpath(options.workspace)
  const outputDirectory = await realpath(path.join(workspace, "release")).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined
      throw error
    },
  )
  const installedApp = await realpath(options.installedAppPath)
  if (
    outputDirectory !== undefined &&
    (installedApp === outputDirectory ||
      installedApp.startsWith(`${outputDirectory}${path.sep}`))
  )
    throw new Error(
      "Run Yakitori from outside the workspace build output before building a local update. Install a copy in Applications first.",
    )
  const before = await snapshot(workspace, options.signal)
  const pkg: unknown = JSON.parse(
    await readFile(path.join(workspace, "package.json"), "utf8"),
  )
  if (
    typeof pkg !== "object" ||
    pkg === null ||
    !("name" in pkg) ||
    pkg.name !== "yakitori" ||
    !("version" in pkg) ||
    typeof pkg.version !== "string"
  )
    throw new Error("Choose the local Yakitori source repository.")
  return {
    release: {
      source: "local",
      version: pkg.version,
      commit: before.commit,
      buildNumber: 0,
      buildAttempt: 0,
      publishedAt: new Date().toISOString(),
      releaseUrl: "",
    },
    async prepare(directory, signal) {
      await runLocalPackage(workspace, options.logPath, signal)
      signal.throwIfAborted()
      const after = await snapshot(workspace, signal)
      if (before.fingerprint !== after.fingerprint)
        throw new Error(
          "Local source changed while building. Check again and rebuild the update.",
        )
      const application = path.join(
        workspace,
        "release",
        "mac-arm64",
        "Yakitori.app",
      )
      const built = parseDesktopBuildInfo(
        JSON.parse(
          await readFile(
            path.join(application, "Contents/Resources/build-info.json"),
            "utf8",
          ),
        ),
      )
      if (
        built.commit !== before.commit ||
        built.dirty !== before.dirty ||
        built.version !== pkg.version
      )
        throw new Error("The local build does not match the selected source.")
      const archivePath = path.join(directory, "local-update.tar")
      await execute(
        "/usr/bin/tar",
        ["-cf", archivePath, "-C", path.dirname(application), "Yakitori.app"],
        {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
          signal,
        },
      )
      signal.throwIfAborted()
      const prepared = await prepareDesktopUpdate({
        archivePath,
        stageDirectory: path.join(directory, "prepared"),
        installedAppPath: options.installedAppPath,
        expectedBuild: built,
      })
      await rm(archivePath)
      return prepared
    },
  }
}
