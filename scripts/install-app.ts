import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

const artifactName = "yakitori-macos-arm64"
const installTarget =
  process.env.YAKITORI_INSTALL_TARGET ?? "/Applications/Yakitori.app"
const [source, ...options] = process.argv.slice(2)
if (
  (source !== "workspace" && source !== "main") ||
  (source === "workspace" && options.length !== 0) ||
  (source === "main" &&
    !(
      options.length === 0 ||
      (options.length === 1 && options[0] === "--build")
    ))
) {
  throw new Error("Usage: pnpm app:install | pnpm app:update [--build]")
}
const localBuild = options.includes("--build")

const staging = await mkdtemp(join(tmpdir(), "yakitori-install-"))
try {
  if (source === "workspace") {
    console.log(
      `Building current workspace at ${process.cwd()} (including local changes)…`,
    )
    await run("pnpm", ["package"])
    await install(join(process.cwd(), "release", "mac-arm64", "Yakitori.app"))
  } else if (localBuild) await buildAndInstallFromMain(staging)
  else await install(await download(staging))
  console.log(`Installed ${installTarget}. Restart Yakitori to run it.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await rm(staging, { recursive: true, force: true })
}

async function download(staging: string): Promise<string> {
  const listed = await capture("gh", [
    "run",
    "list",
    "--workflow",
    "ci.yml",
    "--branch",
    "main",
    "--event",
    "push",
    "--status",
    "success",
    "--limit",
    "1",
    "--json",
    "databaseId,headSha",
  ]).catch(() => undefined)
  if (listed === undefined) {
    throw new Error(
      "Could not query CI workflow runs. Check gh auth, or build locally with: pnpm app:update --build",
    )
  }
  const workflowRun = (
    JSON.parse(listed) as Readonly<{
      databaseId: number
      headSha: string
    }>[]
  )[0]
  if (workflowRun === undefined) {
    throw new Error(
      "No successful CI main-push run yet. Build locally instead: pnpm app:update --build",
    )
  }
  console.log(
    `Downloading main@${workflowRun.headSha.slice(0, 7)} (run ${workflowRun.databaseId})…`,
  )
  await run("gh", [
    "run",
    "download",
    String(workflowRun.databaseId),
    "--name",
    artifactName,
    "--dir",
    staging,
  ])
  await run("tar", ["-xf", join(staging, `${artifactName}.tar`), "-C", staging])
  return join(staging, "Yakitori.app")
}

async function buildAndInstallFromMain(staging: string): Promise<void> {
  await run("git", ["fetch", "origin", "main"])
  const commit = (await capture("git", ["rev-parse", "origin/main"])).trim()
  console.log(
    `Building origin/main@${commit.slice(0, 7)} in an isolated worktree (excluding current workspace changes)…`,
  )
  const worktree = join(staging, "worktree")
  await run("git", ["worktree", "add", "--detach", worktree, commit])
  try {
    await run("pnpm", ["install", "--frozen-lockfile"], worktree)
    await run("pnpm", ["package"], worktree)
    // Install before the throwaway worktree is removed.
    await install(join(worktree, "release", "mac-arm64", "Yakitori.app"))
  } finally {
    await run("git", ["worktree", "remove", "--force", worktree])
  }
}

async function install(app: string): Promise<void> {
  await access(join(app, "Contents", "MacOS", "Yakitori"))
  // Copy beside the destination before touching the usable installation. The
  // final renames stay on one filesystem, including custom install targets.
  await mkdir(dirname(installTarget), { recursive: true })
  const replacement = await mkdtemp(
    join(dirname(installTarget), `.${basename(installTarget)}-install-`),
  )
  const prepared = join(replacement, "prepared.app")
  const backup = join(replacement, "previous.app")
  let keepBackup = false
  try {
    await run("ditto", [app, prepared])
    await access(join(prepared, "Contents", "MacOS", "Yakitori"))
    let hadPrevious = false
    try {
      await rename(installTarget, backup)
      hadPrevious = true
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error
    }
    try {
      await rename(prepared, installTarget)
    } catch (error) {
      if (hadPrevious) {
        try {
          await rename(backup, installTarget)
        } catch (restoreError) {
          keepBackup = true
          throw new AggregateError(
            [error, restoreError],
            `Installation failed and the previous app could not be restored. It remains at ${backup}.`,
          )
        }
      }
      throw error
    }
  } finally {
    if (!keepBackup) await rm(replacement, { recursive: true, force: true })
  }
  // gh downloads carry no quarantine attribute; clear one copied from an
  // older browser-downloaded install so Gatekeeper does not re-prompt.
  await run("xattr", ["-dr", "com.apple.quarantine", installTarget]).catch(
    () => {},
  )
}

function capture(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] })
    let stdout = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} failed (${signal ?? code ?? "?"}).`))
    })
  })
}

function run(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...(cwd === undefined ? {} : { cwd }),
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal ?? code ?? "?"}).`))
    })
  })
}
