import { type ChildProcess, execFile, spawn } from "node:child_process"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"

const exec = promisify(execFile)
const darwin = it.skipIf(process.platform !== "darwin")
const fixtures: { root: string; parent: ChildProcess; workerPid?: number }[] =
  []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.parent.kill("SIGKILL")
    if (fixture.workerPid) {
      try {
        process.kill(fixture.workerPid, "SIGKILL")
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          throw error
      }
    }
    await rm(fixture.root, { recursive: true, force: true })
  }
})

async function bundle(app: string, version: string) {
  await mkdir(join(app, "Contents/MacOS"), { recursive: true })
  await mkdir(join(app, "Contents/Resources"))
  await copyFile("/usr/bin/true", join(app, "Contents/MacOS/Yakitori"))
  await writeFile(join(app, "Contents/Resources/version"), version)
  await writeFile(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.yakitori.app</string><key>CFBundleExecutable</key><string>Yakitori</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  )
  await exec("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.yakitori.app",
    app,
  ])
}

async function fixture(mode = "success") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-update-installer-")),
  )
  const target = join(root, "installed.app")
  const ownsStage = mode === "cleanup-success" || mode === "cleanup-failure"
  const stage = ownsStage ? join(root, "stage") : root
  const prepared = join(stage, "prepared.app")
  await bundle(target, "old")
  await bundle(prepared, "new")
  const workerBinary = ownsStage
    ? join(stage, "runtime/bin/node")
    : process.execPath
  if (ownsStage) {
    await mkdir(dirname(workerBinary), { recursive: true })
    await copyFile(process.execPath, workerBinary)
    // Homebrew's Node executable resolves libnode relative to its runtime.
    // Official standalone Node distributions do not have this companion.
    const libraryDirectory = join(dirname(dirname(process.execPath)), "lib")
    const libraries = await readdir(libraryDirectory).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return []
        throw error
      },
    )
    await mkdir(join(stage, "runtime/lib"))
    for (const library of libraries.filter((name) =>
      /^libnode.*\.dylib$/.test(name),
    ))
      await copyFile(
        join(libraryDirectory, library),
        join(stage, "runtime/lib", library),
      )
  }
  const configPath = join(stage, "config.json")
  const resultPath = join(
    root,
    mode === "rename-fail-result-fail"
      ? "missing/update-result.json"
      : "update-result.json",
  )
  const preload = join(root, "preload.mjs")
  // Keep real codesign/plutil/ditto and filesystem behavior. Intercept launch so
  // tests never register fixture bundles with LaunchServices. Inject one rename
  // failure to exercise recovery after the previous app has moved.
  await writeFile(
    preload,
    `
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
const originalExec = childProcess.execFile;
for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_UNIQUE_ID"])
  process.env[name] = "worker-only";
process.env.YAKITORI_TEST_PRESERVED = "kept";
const replacement = (command, args, options, callback) => {
  if (command === "/usr/bin/open") {
    appendFileSync(${JSON.stringify(join(root, "launches"))}, JSON.stringify(args) + "\\n");
    writeFileSync(${JSON.stringify(join(root, "launch-environment"))}, JSON.stringify(Object.fromEntries(
      ["ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_UNIQUE_ID", "YAKITORI_TEST_PRESERVED"].map(name => [name, options.env?.[name]])
    )));
    try {
      appendFileSync(${JSON.stringify(join(root, "launch-statuses"))}, readFileSync(${JSON.stringify(resultPath)}, "utf8") + "\\n");
    } catch {}
    return originalExec("/usr/bin/true", [], options, callback);
  }
  return originalExec(command, args, options, callback);
};
replacement[promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
  replacement(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({stdout, stderr}));
});
childProcess.execFile = replacement;
const originalRename = fs.rename;
fs.rename = async (from, to) => {
  if ((${JSON.stringify(mode)}.startsWith("rename-fail") || ${JSON.stringify(mode)} === "cleanup-failure") && from.endsWith("/prepared.app") && to === ${JSON.stringify(target)}) {
    throw Object.assign(new Error("injected rename failure"), {code: "EACCES"});
  }
  return originalRename(from, to);
};
syncBuiltinESMExports();
process.on("exit", code => writeFileSync(${JSON.stringify(join(root, "result"))}, String(code)));
`,
  )
  const parentCode = `
import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(configPath)}, JSON.stringify({
  parentPid: process.pid,
  preparedAppPath: ${JSON.stringify(prepared)},
  targetAppPath: ${JSON.stringify(target)},
  relaunchArgs: ["--user-data-dir=/tmp/yakitori-worker-test-profile"],
  resultPath: ${JSON.stringify(resultPath)},
  cleanupDirectory: ${ownsStage ? JSON.stringify(stage) : mode === "unsafe-cleanup" ? JSON.stringify(root) : "undefined"}
}));
const log = openSync(${JSON.stringify(join(root, "worker.log"))}, "a");
const worker = spawn(${JSON.stringify(workerBinary)}, [
  "--import", ${JSON.stringify(preload)},
  ${JSON.stringify(resolve("src/desktop/update-installer.ts"))},
  "--desktop-update-install", ${JSON.stringify(configPath)}
], {detached:true, stdio:["ignore", log, log, "ipc"]});
worker.on("message", message => process.send(message));
worker.on("error", error => {console.error(error); process.exit(1)});
process.send({type:"spawned", pid:worker.pid});
worker.unref();
process.on("message", message => {
  if(message.type === "authorize") worker.send({type:"update-installer-install"});
  if(message.type === "disconnect") worker.disconnect();
  if(message.type === "exit") process.exit(0);
});
`
  const parent = spawn(
    process.execPath,
    ["--input-type=module", "-e", parentCode],
    {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  )
  const state: (typeof fixtures)[number] = { root, parent }
  fixtures.push(state)
  const messages: string[] = []
  parent.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message))
      return
    messages.push(String(message.type))
    if (message.type === "spawned" && "pid" in message)
      state.workerPid = Number(message.pid)
  })
  await expect.poll(() => state.workerPid).toBeTypeOf("number")
  return {
    root,
    parent,
    target,
    prepared,
    stage,
    messages,
    installed: () =>
      readFile(join(target, "Contents/Resources/version"), "utf8"),
    result: () => readFile(join(root, "result"), "utf8").catch(() => undefined),
    launches: () => readFile(join(root, "launches"), "utf8").catch(() => ""),
    launchStatuses: () => readFile(join(root, "launch-statuses"), "utf8"),
    launchEnvironment: () => readFile(join(root, "launch-environment"), "utf8"),
    log: () => readFile(join(root, "worker.log"), "utf8"),
    ready: async () => {
      try {
        await expect
          .poll(() => messages, { timeout: 5000 })
          .toContain("update-installer-ready")
      } catch (error) {
        throw new Error(await readFile(join(root, "worker.log"), "utf8"), {
          cause: error,
        })
      }
    },
    authorize: async () => {
      parent.send({ type: "authorize" })
      await expect.poll(() => messages).toContain("update-installer-armed")
    },
  }
}

darwin(
  "waits for authorization and parent exit, verifies the installed app and preserves relaunch arguments",
  async () => {
    const app = await fixture()
    await app.ready()
    expect(await app.installed()).toBe("old")
    await app.authorize()
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    expect(await app.installed()).toBe("old")
    expect(await app.launches()).toBe("")
    app.parent.send({ type: "exit" })
    await expect.poll(app.result).toBe("0")
    expect(await app.installed()).toBe("new")
    expect(JSON.parse((await app.launchStatuses()).trim())).toEqual({
      status: "installed",
    })
    expect(JSON.parse(await app.launchEnvironment())).toEqual({
      YAKITORI_TEST_PRESERVED: "kept",
    })
    await exec("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      app.target,
    ])
    expect(JSON.parse((await app.launches()).trim())).toEqual([
      "-n",
      app.target,
      "--args",
      "--user-data-dir=/tmp/yakitori-worker-test-profile",
    ])
  },
)

darwin(
  "removes its own cloned runtime and preparation after successful installation",
  async () => {
    const app = await fixture("cleanup-success")
    await app.ready()
    await app.authorize()
    app.parent.send({ type: "exit" })
    await expect.poll(app.result).toBe("0")
    expect(await app.installed()).toBe("new")
    await expect(readFile(join(app.stage, "config.json"))).rejects.toThrow()
  },
  15_000,
)

darwin(
  "removes worker-owned staging after a failed installation restores the previous app",
  async () => {
    const app = await fixture("cleanup-failure")
    await app.ready()
    await app.authorize()
    app.parent.send({ type: "exit" })
    await expect.poll(app.result).toBe("1")
    expect(await app.installed()).toBe("old")
    expect(await app.launches()).toContain(app.target)
    await expect(
      readFile(join(app.stage, "config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  },
  15_000,
)

darwin(
  "rejects a cleanup directory that contains the installed target",
  async () => {
    const app = await fixture("unsafe-cleanup")
    await expect.poll(app.result).toBe("1")
    expect(app.messages).not.toContain("update-installer-ready")
    expect(await app.installed()).toBe("old")
    expect(await app.launches()).toBe("")
    expect(await app.log()).toContain("cleanup directory must own")
  },
)

darwin(
  "retains the installation failure when persisting its result also fails",
  async () => {
    const app = await fixture("rename-fail-result-fail")
    await app.ready()
    await app.authorize()
    app.parent.send({ type: "exit" })
    await expect.poll(app.result).toBe("1")
    expect(await app.installed()).toBe("old")
    expect(await app.log()).toContain("injected rename failure")
    expect(await app.log()).toContain("Could not persist installer result")
  },
)

darwin.each(["disconnect", "crash"])(
  "preserves the installed app when the parent %s before authorization",
  async (action) => {
    const app = await fixture()
    await app.ready()
    if (action === "disconnect") app.parent.send({ type: "disconnect" })
    else app.parent.kill("SIGKILL")
    await expect.poll(app.result).toBe("1")
    expect(await app.installed()).toBe("old")
    expect(await app.launches()).toBe("")
    expect(await app.log()).toContain("before authorizing install")
  },
)

darwin(
  "continues after an armed disconnect but still waits for parent exit",
  async () => {
    const app = await fixture()
    await app.ready()
    await app.authorize()
    app.parent.send({ type: "disconnect" })
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    expect(await app.installed()).toBe("old")
    app.parent.send({ type: "exit" })
    await expect.poll(app.result).toBe("0")
    expect(await app.installed()).toBe("new")
  },
)

darwin(
  "rejects a prepared app changed after readiness and reopens the old target",
  async () => {
    const app = await fixture()
    await app.ready()
    await writeFile(
      join(app.prepared, "Contents/Resources/version"),
      "tampered",
    )
    await app.authorize()
    app.parent.send({ type: "exit" })
    await expect.poll(app.result).toBe("1")
    expect(await app.installed()).toBe("old")
    expect(await app.launches()).toContain(app.target)
    await exec("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      app.target,
    ])
  },
)

darwin("rolls back the old app when the replacement rename fails", async () => {
  const app = await fixture("rename-fail")
  await app.ready()
  await app.authorize()
  app.parent.send({ type: "exit" })
  await expect.poll(app.result).toBe("1")
  expect(await app.installed()).toBe("old")
  expect(await app.launches()).toContain(app.target)
  expect(await app.log()).toContain("injected rename failure")
  expect(JSON.parse((await app.launchStatuses()).trim())).toEqual({
    status: "failed",
    message: "injected rename failure",
  })
  await exec("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    app.target,
  ])
})
