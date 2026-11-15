import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import type { DesktopBuildInfo } from "../src/protocol/desktop-update.ts"

const run = promisify(execFile)
const repository = "YakiHugo/yakitori"

export async function prepareDesktopBuildInfo(
  options: { cwd?: string; env?: NodeJS.ProcessEnv; builtAt?: Date } = {},
): Promise<DesktopBuildInfo> {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  let sourceRepository = env.GITHUB_REPOSITORY
  if (sourceRepository === undefined) {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], {
      cwd,
    })
    const remote = stdout.trim()
    const sshPath = /^git@github\.com:([^?#]+)$/.exec(remote)?.[1]
    if (sshPath !== undefined) sourceRepository = sshPath
    else {
      const url = new URL(remote)
      if (
        url.hostname !== "github.com" ||
        !["https:", "ssh:"].includes(url.protocol) ||
        url.port ||
        url.password ||
        url.search ||
        url.hash ||
        (url.username && !(url.protocol === "ssh:" && url.username === "git"))
      ) {
        throw new Error("Desktop builds require a trusted GitHub origin.")
      }
      sourceRepository = url.pathname.slice(1)
    }
    sourceRepository = sourceRepository.replace(/\.git$/, "")
  }
  if (sourceRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `Desktop builds require the ${repository} GitHub repository.`,
    )
  }
  const [{ stdout: commit }, { stdout: status }, packageContents] =
    await Promise.all([
      run("git", ["rev-parse", "HEAD"], { cwd }),
      // Git naturally excludes ignored generated bundles and includes preexisting
      // tracked changes and untracked source files.
      run("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd,
      }),
      readFile(resolve(cwd, "package.json"), "utf8"),
    ])
  if (!/^[a-f0-9]{40}$/.test(commit.trim())) {
    throw new Error("Desktop build commit must be a full GitHub commit SHA.")
  }
  const pkg: unknown = JSON.parse(packageContents)
  if (
    typeof pkg !== "object" ||
    pkg === null ||
    !("version" in pkg) ||
    typeof pkg.version !== "string" ||
    pkg.version.length === 0
  ) {
    throw new Error("Desktop build package.json must contain a version.")
  }
  const main =
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_EVENT_NAME === "push" &&
    env.GITHUB_REF === "refs/heads/main"
  const buildNumber = numericRunValue(env.GITHUB_RUN_NUMBER, main)
  const buildAttempt = numericRunValue(env.GITHUB_RUN_ATTEMPT, main)
  return {
    repository,
    version: pkg.version,
    commit: commit.trim(),
    dirty: status.length > 0,
    channel: main ? "main" : "local",
    buildNumber,
    buildAttempt,
    builtAt: (options.builtAt ?? new Date()).toISOString(),
    platform: "darwin",
    arch: "arm64",
  }
}

function numericRunValue(value: string | undefined, required: boolean): number {
  if (value === undefined && !required) return 0
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new Error("GitHub run number and attempt must be positive integers.")
  }
  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new Error(
      "GitHub run number and attempt exceed safe integer precision.",
    )
  }
  return result
}

if (import.meta.main) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(
      "Desktop packaging currently requires macOS on Apple Silicon.",
    )
  const destination = resolve("dist/build-info.json")
  const build = await prepareDesktopBuildInfo()
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(build, null, 2)}\n`)
  console.log(`Wrote ${destination}`)
}
