import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { type ElectronApplication, expect, test } from "@playwright/test"
import { signDesktopApplication } from "../../src/desktop/app-signing.ts"
import { createAppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import type { DesktopBuildInfo } from "../../src/protocol/desktop-update.ts"
import { McpClient } from "../../src/runtime/mcp-client.ts"
import { createSmokeEnvironment, runFauxTurn } from "./fixtures.ts"

const execute = promisify(execFile)
const releaseTag = "desktop-main-999999-1"
const releaseBase = `https://github.com/YakiHugo/yakitori/releases/download/${releaseTag}`
const helperPath = "Contents/Resources/computer/Yakitori Computer.app"
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex")

async function stopOwnedProcesses(root: string): Promise<void> {
  await expect(async () => {
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,command="])
    const owned = stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      return match?.[2]?.includes(root) ? [Number(match[1])] : []
    })
    for (const pid of owned) {
      try {
        process.kill(pid, "SIGTERM")
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          throw error
      }
    }
    expect(owned).toEqual([])
  }).toPass({ timeout: 10_000 })
}

async function readPermissions(applicationPath: string) {
  const client = new McpClient(
    "update-permission-probe",
    {
      command: join(
        applicationPath,
        helperPath,
        "Contents/MacOS/yakitori-computer",
      ),
      args: ["--mcp"],
    },
    () => {},
    () => {},
    () => {},
  )
  try {
    const control = (await client.start()).find(
      (tool) => tool.name === "control",
    )
    if (!control) throw new Error("Computer helper is missing its control tool")
    // Status reads existing grants. It never asks for permissions, captures a
    // screen, or performs computer input.
    const status = await client.bindTool(control)({ action: "status" })
    const value = status.structuredContent
    if (
      status.isError ||
      typeof value?.accessibility !== "boolean" ||
      typeof value.screenRecording !== "boolean"
    )
      throw new Error("Computer helper did not return permission status")
    return {
      accessibility: value.accessibility,
      screenRecording: value.screenRecording,
    }
  } finally {
    await client.close()
  }
}

async function updateFixture(completeArchive: boolean) {
  const environment = await createSmokeEnvironment()
  const root = await realpath(environment.root)
  const target = join(root, "Applications", "Yakitori.app")
  await mkdir(join(root, "Applications"))
  await cp(resolve("release/mac-arm64/Yakitori.app"), target, {
    recursive: true,
    verbatimSymlinks: true,
  })
  const installedHash = sha256(
    await readFile(join(target, "Contents", "Resources", "app.asar")),
  )
  const build: DesktopBuildInfo = {
    repository: "YakiHugo/yakitori",
    version: "0.0.0",
    commit: "a".repeat(40),
    dirty: false,
    channel: "main",
    buildNumber: 999999,
    buildAttempt: 1,
    builtAt: "2026-11-15T00:00:00.000Z",
    platform: "darwin",
    arch: "arm64",
  }
  let archivePath: string | undefined
  const payload = Buffer.from("corrupt!")
  let archiveHash = sha256(Buffer.from("verified"))
  let archiveSize = payload.length
  if (completeArchive) {
    const source = join(root, "release", "Yakitori.app")
    await mkdir(join(root, "release"))
    await cp(target, source, { recursive: true, verbatimSymlinks: true })
    await writeFile(
      join(source, "Contents/Resources/build-info.json"),
      JSON.stringify(build),
    )
    await mkdir(join(source, helperPath, "Contents/Resources"), {
      recursive: true,
    })
    await writeFile(
      join(source, helperPath, "Contents/Resources/update-test.txt"),
      "new helper resource",
    )
    // The release has CI's ad-hoc helper identity. The real preparation stage
    // must restore the installed client's certificate before offering restart.
    await execute("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "com.yakitori.computer",
      join(source, helperPath),
    ])
    await signDesktopApplication(source)
    archivePath = join(root, "update.tar")
    await execute(
      "/usr/bin/tar",
      ["-cf", archivePath, "-C", join(root, "release"), "Yakitori.app"],
      {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      },
    )
    const hash = createHash("sha256")
    archiveSize = 0
    for await (const chunk of createReadStream(archivePath)) {
      archiveSize += chunk.length
      hash.update(chunk)
    }
    archiveHash = hash.digest("hex")
  }
  const manifest = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      build,
      archive: {
        name: "yakitori-macos-arm64.tar",
        sha256: archiveHash,
        size: archiveSize,
      },
    }),
  )
  let archiveRequests = 0
  const server = createServer((request, response) => {
    if (request.url === "/releases") {
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify([
          {
            tag_name: releaseTag,
            draft: false,
            prerelease: true,
            target_commitish: build.commit,
            published_at: build.builtAt,
            html_url: `https://github.com/YakiHugo/yakitori/releases/tag/${releaseTag}`,
            assets: [
              {
                name: "update-manifest.json",
                state: "uploaded",
                size: manifest.length,
                digest: `sha256:${sha256(manifest)}`,
                browser_download_url: `${releaseBase}/update-manifest.json`,
              },
              {
                name: "yakitori-macos-arm64.tar",
                state: "uploaded",
                size: archiveSize,
                digest: `sha256:${archiveHash}`,
                browser_download_url: `${releaseBase}/yakitori-macos-arm64.tar`,
              },
            ],
          },
        ]),
      )
    } else if (request.url === "/update-manifest.json") {
      response.setHeader("Content-Length", manifest.length)
      response.end(manifest)
    } else if (request.url === "/yakitori-macos-arm64.tar") {
      archiveRequests += 1
      response.setHeader("Content-Length", archiveSize)
      if (archivePath) createReadStream(archivePath).pipe(response)
      else response.end(payload)
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing update fixture address")
  return {
    environment,
    target,
    root,
    installedHash,
    userData: join(root, "user-data"),
    releaseServer: `http://127.0.0.1:${address.port}`,
    requests: () => archiveRequests,
    async cleanup() {
      server.closeAllConnections()
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      )
      await environment.cleanup()
    },
  }
}

async function routeReleaseRequests(
  application: ElectronApplication,
  base: string,
) {
  await application.evaluate((_electron, fixtureBase) => {
    const request = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input))
      if (url.hostname !== "api.github.com" && url.hostname !== "github.com")
        return request(input, init)
      const name = url.pathname.includes("/releases/download/")
        ? url.pathname.split("/").at(-1)
        : "releases"
      return request(`${fixtureBase}/${name}`, init)
    }
  }, base)
}

test("desktop refuses a corrupt download and keeps the installed app running", async ({
  playwright,
}) => {
  test.skip(process.platform !== "darwin")
  const fixture = await updateFixture(false)
  await mkdir(fixture.userData, { recursive: true })
  await writeFile(
    join(fixture.userData, "update-result.json"),
    JSON.stringify({
      status: "failed",
      message: "The previous update was restored.",
    }),
  )
  let app: ElectronApplication | undefined
  try {
    app = await playwright._electron.launch({
      executablePath: join(fixture.target, "Contents/MacOS/Yakitori"),
      args: [`--user-data-dir=${fixture.userData}`],
      env: fixture.environment.env,
      cwd: fixture.root,
    })
    await routeReleaseRequests(app, fixture.releaseServer)
    const page = await app.firstWindow()
    await page
      .getByRole("button", { name: "Update failed", exact: true })
      .click()
    await expect(page.getByRole("alert")).toContainText(
      "previous update was restored",
    )
    await expect(
      readFile(join(fixture.userData, "update-result.json")),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await page
      .getByRole("button", { name: "Update available", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Download update", exact: true })
      .click()
    await expect(page.getByRole("alert")).toContainText("integrity check")
    expect(app.process().exitCode).toBeNull()
    expect(fixture.requests()).toBe(1)
    expect(
      sha256(
        await readFile(join(fixture.target, "Contents/Resources/app.asar")),
      ),
    ).toBe(fixture.installedHash)
    await expect(
      page.getByRole("button", { name: "Retry", exact: true }),
    ).toBeEnabled()
  } finally {
    await app?.close()
    await fixture.cleanup()
  }
})

test("desktop restores the local signer and installs a prepared release after graceful exit", async ({
  playwright,
}) => {
  // This flow reads/seals a full app and starts two desktop instances.
  test.setTimeout(120_000)
  test.skip(process.platform !== "darwin")
  const sourceHelper = resolve("release/mac-arm64/Yakitori.app", helperPath)
  const requirement = await execute("/usr/bin/codesign", [
    "-d",
    "-r-",
    sourceHelper,
  ])
  const localRequirement = `${requirement.stdout}\n${requirement.stderr}`.match(
    /designated => (.*certificate leaf = H"[a-fA-F0-9]+".*)/,
  )
  test.skip(
    localRequirement === null,
    "This runner has no local certificate identity; native preparation tests cover its failure path.",
  )
  const fixture = await updateFixture(true)
  let app: ElectronApplication | undefined
  let relaunchedPid: number | undefined
  let relaunchedSidecar: number | undefined
  let client: ReturnType<typeof createAppRpcClient> | undefined
  const logs: string[] = []
  try {
    const permissionsBefore = await readPermissions(fixture.target)
    app = await playwright._electron.launch({
      executablePath: join(fixture.target, "Contents/MacOS/Yakitori"),
      args: [`--user-data-dir=${fixture.userData}`],
      // Credential/config homes stay isolated; native signing deliberately uses
      // the current user's existing keychain, without creating or exporting keys.
      env: {
        ...fixture.environment.env,
        HOME: process.env.HOME ?? fixture.environment.env.HOME ?? "",
      },
      cwd: fixture.root,
    })
    app.on("console", (message) => logs.push(message.text()))
    app.process().stderr?.on("data", (chunk: Buffer) => {
      logs.push(chunk.toString())
    })
    await routeReleaseRequests(app, fixture.releaseServer)
    const page = await app.firstWindow()
    await runFauxTurn(page)
    const oldPid = app.process().pid
    const oldUrl = page.url()
    const exit = new Promise<void>((done) =>
      app?.process().once("exit", () => done()),
    )
    await page
      .getByRole("button", { name: "Update available", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Download update", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Restart and update", exact: true }),
    ).toBeVisible({ timeout: 45_000 })
    expect(app.process().exitCode).toBeNull()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => {
        Reflect.set(globalThis, "updateUnloadPrompted", true)
        return 0
      }
    })
    // Electron's will-prevent-unload handler owns this native decision. Keep
    // Playwright from racing it with automatic CDP dialog dismissal.
    page.on("dialog", () => {})
    await page.evaluate(() => {
      const handler = (event: BeforeUnloadEvent) => {
        event.preventDefault()
        event.returnValue = ""
      }
      Reflect.set(window, "updateBeforeUnload", handler)
      window.addEventListener("beforeunload", handler)
    })
    await page
      .getByRole("button", { name: "Restart and update", exact: true })
      .click()
    await expect
      .poll(() =>
        app?.evaluate(() => Reflect.get(globalThis, "updateUnloadPrompted")),
      )
      .toBe(true)
    await expect(
      page.getByRole("button", { name: "Restart and update", exact: true }),
    ).toBeVisible({ timeout: 20_000 })
    expect(app.process().exitCode).toBeNull()
    await page.evaluate(() => {
      const handler = Reflect.get(window, "updateBeforeUnload") as (
        event: BeforeUnloadEvent,
      ) => void
      window.removeEventListener("beforeunload", handler)
    })
    await page.screenshot({
      path: test.info().outputPath("desktop-update-ready.png"),
    })
    await page
      .getByRole("button", { name: "Restart and update", exact: true })
      .click()
    await exit
    expect(app.process().exitCode).toBe(0)
    app = undefined
    await expect(async () => {
      const { stdout } = await execute("/bin/ps", [
        "-axo",
        "pid=,ppid=,command=",
      ])
      const processes = stdout.split("\n").flatMap((line) => {
        const parsed = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        return parsed
          ? [
              {
                pid: Number(parsed[1]),
                parent: Number(parsed[2]),
                command: parsed[3] ?? "",
              },
            ]
          : []
      })
      relaunchedPid = processes.find(
        (process) =>
          process.pid !== oldPid &&
          process.command.startsWith(
            `${join(fixture.target, "Contents/MacOS/Yakitori")} --user-data-dir=`,
          ),
      )?.pid
      expect(relaunchedPid).toBeDefined()
      relaunchedSidecar = processes.find(
        (process) =>
          process.parent === relaunchedPid &&
          process.command.includes("app.asar.unpacked/dist/desktop/server.js"),
      )?.pid
      expect(relaunchedSidecar).toBeDefined()
      const ports = await execute("/usr/sbin/lsof", [
        "-nP",
        "-a",
        "-p",
        String(relaunchedSidecar),
        "-iTCP",
        "-sTCP:LISTEN",
        "-Fn",
      ])
      const port = /n127\.0\.0\.1:(\d+)/.exec(ports.stdout)?.[1]
      expect(port).toBeDefined()
      client?.close()
      client = createAppRpcClient({ apiBase: `http://127.0.0.1:${port}` })
      const sessions = await client.request("session/list", {})
      expect(sessions.sessions).toHaveLength(1)
    }).toPass({ timeout: 20_000 })
    await expect(fetch(oldUrl)).rejects.toThrow()
    const installed = JSON.parse(
      await readFile(
        join(fixture.target, "Contents/Resources/build-info.json"),
        "utf8",
      ),
    ) as DesktopBuildInfo
    expect(installed.buildNumber).toBe(999999)
    await execute("/usr/bin/codesign", [
      "--verify",
      "--strict",
      `-R=${localRequirement?.[1]}`,
      join(fixture.target, helperPath),
    ])
    await execute("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      fixture.target,
    ])
    expect(
      await readFile(
        join(fixture.target, helperPath, "Contents/Resources/update-test.txt"),
        "utf8",
      ),
    ).toBe("new helper resource")
    const permissionsAfter = await readPermissions(fixture.target)
    expect(permissionsAfter).toEqual(permissionsBefore)
    console.log("Native permissions preserved across update:", permissionsAfter)
  } finally {
    client?.close()
    const processSnapshot = await execute("/bin/ps", [
      "-axo",
      "pid=,ppid=,command=",
    ])
    logs.push(
      processSnapshot.stdout
        .split("\n")
        .filter((line) => line.includes(fixture.root))
        .join("\n"),
    )
    try {
      logs.push(await readFile(join(fixture.userData, "update.log"), "utf8"))
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        logs.push(`Could not read installer diagnostics: ${String(error)}`)
    }
    await test.info().attach("desktop-update-diagnostics", {
      body: logs.join("\n"),
      contentType: "text/plain",
    })
    try {
      if (
        app !== undefined &&
        app.process().exitCode === null &&
        app.process().signalCode === null
      ) {
        await app.evaluate(({ dialog }) => {
          dialog.showMessageBoxSync = () => 1
        })
        await app.close()
      }
    } finally {
      await stopOwnedProcesses(fixture.root)
      await fixture.cleanup()
    }
  }
})
