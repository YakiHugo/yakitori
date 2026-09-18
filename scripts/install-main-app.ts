// Installs the latest main-branch desktop build into /Applications.
//
// Default mode downloads the yakitori-macos-arm64 artifact from the newest
// successful Desktop workflow run on origin/main (requires the gh CLI).
// `--local` skips CI and builds origin/main in a throwaway git worktree,
// leaving the current checkout untouched.
// YAKITORI_INSTALL_TARGET overrides the install destination.
import { spawn } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const artifactName = "yakitori-macos-arm64"
const installTarget =
  process.env.YAKITORI_INSTALL_TARGET ?? "/Applications/Yakitori.app"
const localBuild = process.argv.includes("--local")

const staging = await mkdtemp(join(tmpdir(), "yakitori-install-"))
try {
  if (localBuild) await buildAndInstallFromMain(staging)
  else await install(await download(staging))
  console.log(`Installed ${installTarget}. Restart Yakitori to run it.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
} finally {
  await rm(staging, { recursive: true, force: true })
}

async function download(staging: string): Promise<string> {
  const listed = await capture("gh", [
    "run",
    "list",
    "--workflow",
    "desktop.yml",
    "--branch",
    "main",
    "--status",
    "success",
    "--limit",
    "1",
    "--json",
    "databaseId,headSha",
  ]).catch(() => undefined)
  if (listed === undefined) {
    throw new Error(
      "Could not query Desktop workflow runs. Check gh auth, or build locally with: pnpm install:main --local",
    )
  }
  const run = (
    JSON.parse(listed) as readonly {
      readonly databaseId: number
      readonly headSha: string
    }[]
  )[0]
  if (run === undefined) {
    throw new Error(
      "No successful Desktop run on main yet. Build locally instead: pnpm install:main --local",
    )
  }
  console.log(
    `Downloading main@${run.headSha.slice(0, 7)} (run ${run.databaseId})…`,
  )
  await run("gh", [
    "run",
    "download",
    String(run.databaseId),
    "--name",
    artifactName,
    "--dir",
    staging,
  ])
  return join(staging, "Yakitori.app")
}

async function buildAndInstallFromMain(staging: string): Promise<void> {
  await run("git", ["fetch", "origin", "main"])
  const worktree = join(staging, "worktree")
  await run("git", ["worktree", "add", "--detach", worktree, "origin/main"])
  try {
    await run("pnpm", ["install", "--frozen-lockfile"], worktree)
    await run("pnpm", ["package:desktop"], worktree)
    // Install before the throwaway worktree is removed.
    await install(join(worktree, "release", "mac-arm64", "Yakitori.app"))
  } finally {
    await run("git", ["worktree", "remove", "--force", worktree])
  }
}

async function install(app: string): Promise<void> {
  await access(join(app, "Contents", "MacOS", "Yakitori"))
  // The artifact zip may not preserve the executable bit.
  await run("chmod", ["+x", join(app, "Contents", "MacOS", "Yakitori")])
  await rm(installTarget, { recursive: true, force: true })
  await run("ditto", [app, installTarget])
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
