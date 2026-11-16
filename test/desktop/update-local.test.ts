import { execFile } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { afterEach, expect, test, vi } from "vitest"
import {
  checkLocalDesktopUpdate,
  runLocalPackage,
} from "../../src/desktop/update-local.ts"
import { prepareDesktopUpdate } from "../../src/desktop/update-preparation.ts"

vi.mock("../../src/desktop/update-preparation.ts", () => ({
  prepareDesktopUpdate: vi.fn(),
}))

const exec = promisify(execFile)
const it = test.skipIf(process.platform !== "darwin")
const roots: string[] = []
const processes = new Set<number>()

afterEach(async () => {
  for (const pid of processes) {
    try {
      process.kill(pid, "SIGKILL")
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error
    }
  }
  processes.clear()
  vi.unstubAllEnvs()
  vi.mocked(prepareDesktopUpdate).mockReset()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function setup(program: string, workspaceName = "checkout") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-local-update-")),
  )
  roots.push(root)
  const workspace = join(root, workspaceName)
  const bin = join(root, "bin")
  const zdotdir = join(root, "shell")
  await Promise.all([workspace, bin, zdotdir].map((path) => mkdir(path)))
  for (const name of [".zprofile", ".zshrc"]) {
    await writeFile(
      join(zdotdir, name),
      'export PATH="$YAKITORI_TEST_BIN:$PATH"\n',
    )
  }
  const programPath = join(root, "fake-pnpm.cjs")
  await writeFile(programPath, program)
  const pnpm = join(bin, "pnpm")
  await writeFile(
    pnpm,
    '#!/bin/sh\nexec "$YAKITORI_TEST_NODE" "$YAKITORI_TEST_SCRIPT" "$@"\n',
  )
  await chmod(pnpm, 0o700)
  return {
    root,
    workspace,
    logPath: join(root, "build.log"),
    environment: {
      ...process.env,
      ZDOTDIR: zdotdir,
      YAKITORI_TEST_BIN: bin,
      YAKITORI_TEST_NODE: process.execPath,
      YAKITORI_TEST_SCRIPT: programPath,
    },
  }
}

async function repository(program: string) {
  const fixture = await setup(program)
  await writeFile(
    join(fixture.workspace, "package.json"),
    '{"name":"yakitori","version":"2.3.4"}\n',
  )
  await writeFile(join(fixture.workspace, ".gitignore"), "release/\n")
  await writeFile(join(fixture.workspace, "tracked.txt"), "committed\n")
  await exec("git", ["init", "-q"], { cwd: fixture.workspace })
  await exec("git", ["add", "."], { cwd: fixture.workspace })
  await exec(
    "git",
    [
      "-c",
      "user.name=Local update test",
      "-c",
      "user.email=update@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: fixture.workspace },
  )
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: fixture.workspace,
  })
  const stage = join(fixture.root, "stage")
  const installedAppPath = join(fixture.root, "installed.app")
  await Promise.all([mkdir(stage), mkdir(installedAppPath)])
  for (const [key, value] of Object.entries(fixture.environment)) {
    if (
      value !== undefined &&
      (key === "ZDOTDIR" || key.startsWith("YAKITORI_TEST_"))
    )
      vi.stubEnv(key, value)
  }
  return { ...fixture, stage, installedAppPath, commit: stdout.trim() }
}

const packageApplication = `
const { execFileSync } = require("node:child_process")
const { mkdirSync, readFileSync, writeFileSync, appendFileSync } = require("node:fs")
const path = require("node:path")
if (process.argv.slice(2).join(" ") !== "package") throw new Error("Wrong package command")
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).length > 0
const metadata = {
  repository: "YakiHugo/yakitori",
  version: JSON.parse(readFileSync("package.json", "utf8")).version,
  commit, dirty: process.env.YAKITORI_TEST_WRONG_DIRTY ? false : dirty,
  channel: "local", buildNumber: 0, buildAttempt: 0,
  builtAt: "2026-11-16T00:00:00Z", platform: "darwin", arch: "arm64",
}
const resources = path.join("release", "mac-arm64", "Yakitori.app", "Contents", "Resources")
mkdirSync(resources, { recursive: true })
writeFileSync(path.join(resources, "build-info.json"), JSON.stringify(metadata))
if (process.env.YAKITORI_TEST_MUTATE_SOURCE) appendFileSync("untracked.txt", "changed during package\\n")
console.log("fake package completed")
`

it.each([
  "direct",
  "app-alias",
  "output-alias",
])("rejects a running app inside the local build output through %s paths", async (variant) => {
  const value = await repository(packageApplication)
  const output =
    variant === "output-alias"
      ? join(value.root, "linked-build-output")
      : join(value.workspace, "release")
  const running = join(output, "mac-arm64", "Running.app")
  await mkdir(running, { recursive: true })
  if (variant === "output-alias")
    await symlink(output, join(value.workspace, "release"), "dir")
  const installedAppPath =
    variant === "app-alias" ? join(value.root, "running-alias.app") : running
  if (variant === "app-alias") await symlink(running, installedAppPath, "dir")
  await expect(
    checkLocalDesktopUpdate({
      ...value,
      installedAppPath,
    }),
  ).rejects.toThrow(/outside the workspace build output/)
  expect(prepareDesktopUpdate).not.toHaveBeenCalled()
  await expect(readFile(value.logPath)).rejects.toMatchObject({
    code: "ENOENT",
  })
})

it.each([
  "tracked",
  "untracked",
])("prepares a local archive with honest dirty metadata after %s source edits", async (change) => {
  const value = await repository(packageApplication)
  await writeFile(
    join(value.workspace, `${change}.txt`),
    "local source change\n",
  )
  vi.mocked(prepareDesktopUpdate).mockImplementationOnce(async (options) => {
    expect(options.installedAppPath).toBe(value.installedAppPath)
    expect(options.expectedBuild).toMatchObject({
      commit: value.commit,
      dirty: true,
      version: "2.3.4",
      channel: "local",
    })
    const { stdout } = await exec("/usr/bin/tar", ["-tf", options.archivePath])
    expect(stdout).toContain("Yakitori.app/Contents/Resources/build-info.json")
    const appPath = join(options.stageDirectory, "Yakitori.app")
    await mkdir(appPath, { recursive: true })
    return { appPath }
  })
  const checked = await checkLocalDesktopUpdate(value)
  expect(checked.release).toMatchObject({
    source: "local",
    version: "2.3.4",
    commit: value.commit,
    buildNumber: 0,
    buildAttempt: 0,
    releaseUrl: "",
  })
  expect(prepareDesktopUpdate).not.toHaveBeenCalled()
  const result = await checked.prepare(
    value.stage,
    new AbortController().signal,
  )
  expect(result.appPath).toBe(join(value.stage, "prepared", "Yakitori.app"))
  expect(await readFile(value.logPath, "utf8")).toContain(
    "fake package completed",
  )
  await expect(
    readFile(join(value.stage, "local-update.tar")),
  ).rejects.toMatchObject({ code: "ENOENT" })
})

it("rejects package metadata that hides dirty source changes", async () => {
  const value = await repository(packageApplication)
  await writeFile(join(value.workspace, "untracked.txt"), "local source\n")
  vi.stubEnv("YAKITORI_TEST_WRONG_DIRTY", "1")
  const checked = await checkLocalDesktopUpdate(value)
  await expect(
    checked.prepare(value.stage, new AbortController().signal),
  ).rejects.toThrow(/does not match the selected source/)
  expect(prepareDesktopUpdate).not.toHaveBeenCalled()
})

it("detects untracked contents changing during packaging even when Git remains dirty", async () => {
  const value = await repository(packageApplication)
  await writeFile(join(value.workspace, "untracked.txt"), "before package\n")
  vi.stubEnv("YAKITORI_TEST_MUTATE_SOURCE", "1")
  const checked = await checkLocalDesktopUpdate(value)
  await expect(
    checked.prepare(value.stage, new AbortController().signal),
  ).rejects.toThrow(/source changed while building/)
  expect(prepareDesktopUpdate).not.toHaveBeenCalled()
})

it("passes the selected workspace as literal shell data and strips Electron and Node IPC variables", async () => {
  const value = await setup(
    `
const { writeFileSync } = require("node:fs")
writeFileSync(process.env.YAKITORI_TEST_OBSERVATION, JSON.stringify({
  cwd: process.cwd(), argv: process.argv.slice(2),
  env: Object.fromEntries(["ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_UNIQUE_ID"]
    .filter((key) => key in process.env).map((key) => [key, process.env[key]])),
}))
`,
    `source 'quoted' "$(touch INJECTED)"`,
  )
  const observation = join(value.root, "observed.json")
  await runLocalPackage(
    value.workspace,
    value.logPath,
    new AbortController().signal,
    {
      ...value.environment,
      YAKITORI_TEST_OBSERVATION: observation,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_CHANNEL_FD: "999",
      NODE_CHANNEL_SERIALIZATION_MODE: "advanced",
      NODE_UNIQUE_ID: "unexpected-worker",
    },
  )
  expect(JSON.parse(await readFile(observation, "utf8"))).toEqual({
    cwd: value.workspace,
    argv: ["package"],
    env: {},
  })
  await expect(readFile(join(value.root, "INJECTED"))).rejects.toMatchObject({
    code: "ENOENT",
  })
  await expect(
    readFile(join(value.workspace, "INJECTED")),
  ).rejects.toMatchObject({ code: "ENOENT" })
})

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      return await readFile(path, "utf8")
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error
    }
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${path}`)
}

it.each([
  false,
  true,
])("kills a TERM-resistant grandchild before cancellation rejects after its leader exits (transient probe EPERM: %s)", async (denyProbe) => {
  const value = await setup(`
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const code = 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.YAKITORI_TEST_CHILD_READY, String(process.pid)); setInterval(() => {}, 1000)'
spawn(process.execPath, ["-e", code], { stdio: "ignore", env: process.env })
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1000)
`)
  const ready = join(value.root, "grandchild.pid")
  const controller = new AbortController()
  const kill = process.kill.bind(process)
  let killedGroup: number | undefined
  let denied = false
  const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (denyProbe && pid === killedGroup && signal === 0 && !denied) {
      denied = true
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
    }
    const result = kill(pid, signal)
    if (pid < 0 && signal === "SIGKILL") killedGroup = pid
    return result
  })
  try {
    const running = runLocalPackage(
      value.workspace,
      value.logPath,
      controller.signal,
      {
        ...value.environment,
        YAKITORI_TEST_CHILD_READY: ready,
      },
    )
    // Attach the rejection handler before requesting cancellation.
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    })
    const pid = Number(await waitForFile(ready))
    processes.add(pid)
    controller.abort()
    await rejected
    let alive = true
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          throw error
        alive = false
        break
      }
      // A dead orphan may briefly await reaping by launchd.
      await delay(10)
    }
    expect(alive).toBe(false)
    expect(denied).toBe(denyProbe)
    processes.delete(pid)
  } finally {
    probe.mockRestore()
  }
}, 15_000)
