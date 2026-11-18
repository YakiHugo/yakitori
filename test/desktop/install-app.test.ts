import { execFile } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"

const execute = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function fixture(registryResponse = "stable") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-installer-test-")),
  )
  temporary.push(root)
  const tools = join(root, "tools")
  const applications = join(root, "Applications")
  const source = join(root, "source.app")
  const commands = join(root, "commands.jsonl")
  const target = join(applications, "Yakitori.app")
  const catalogVersionPath = join(root, "src/runtime/codex-client-version.json")
  await mkdir(tools)
  await mkdir(join(root, "src/runtime"), { recursive: true })
  await writeFile(catalogVersionPath, '{"clientVersion":"1.0.0"}\n')
  await mkdir(join(source, "Contents", "MacOS"), { recursive: true })
  await mkdir(join(target, "Contents", "MacOS"), { recursive: true })
  await writeFile(
    join(source, "Contents", "MacOS", "Yakitori"),
    "new executable",
  )
  await writeFile(
    join(target, "Contents", "MacOS", "Yakitori"),
    "old executable",
  )
  await writeFile(join(target, "old-only.txt"), "previous installation")
  const fakeTool = `#!${process.execPath}
const { basename, join } = require("node:path");
const { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({command, args, cwd: process.cwd()}) + "\\n");
if (command === "git" && args[0] === "rev-parse") console.log("abcdef0123456789");
if (command === "git" && args[1] === "add") mkdirSync(args[3], {recursive: true});
if (command === "git" && args[1] === "remove") rmSync(args[3], {recursive: true, force: true});
if (command === "pnpm" && args[0] === "package") {
  if (process.env.FAIL_BUILD === "1") process.exit(1);
  const app = join(process.cwd(), "release/mac-arm64/Yakitori.app");
  cpSync(process.env.PACKAGE_FIXTURE, app, {recursive: true});
  const catalogVersion = join(process.cwd(), "src/runtime/codex-client-version.json");
  if (existsSync(catalogVersion)) cpSync(catalogVersion, join(app, "Contents/codex-client-version.json"));
}
if (command === "gh" && args[1] === "list") console.log(JSON.stringify([{databaseId: 1, headSha: "1234567"}]));
if (command === "tar") cpSync(process.env.PACKAGE_FIXTURE, join(args[args.indexOf("-C") + 1], "Yakitori.app"), { recursive: true });
if (command === "ditto") {
  if (process.env.COPY_MODE !== "success") {
    mkdirSync(args[1], { recursive: true });
    writeFileSync(join(args[1], "partial.txt"), "incomplete copy");
    if (process.env.COPY_MODE === "fail") process.exit(1);
  } else cpSync(args[0], args[1], { recursive: true });
}
`
  for (const name of ["gh", "tar", "ditto", "xattr", "git", "pnpm"])
    await writeFile(join(tools, name), fakeTool, { mode: 0o755 })
  const fault = join(root, "rename-fault.mjs")
  await writeFile(
    fault,
    `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (process.env.FAIL_PUBLISH === "1" && to === process.env.YAKITORI_INSTALL_TARGET && (!from.endsWith("previous.app") || process.env.FAIL_RESTORE === "1"))
    throw Object.assign(new Error("Publish rename failed"), { code: "EIO" });
  return rename(from, to);
};
syncBuiltinESMExports();
globalThis.fetch = async (input) => {
  if (String(input) !== "https://registry.npmjs.org/@openai%2Fcodex/latest")
    throw new Error("Unexpected URL: " + input);
  const mode = process.env.CODEX_REGISTRY_RESPONSE;
  if (mode === "offline") throw new TypeError("fetch failed");
  if (mode === "unavailable") return new Response(null, { status: 503 });
  if (mode === "invalid JSON") return new Response("unavailable");
  return Response.json({ name: "@openai/codex", version: mode === "prerelease" ? "1.2.0-beta.1" : "1.1.0" });
};
`,
  )
  const run = (
    copyMode: string,
    failPublish = false,
    failRestore = false,
    args = ["main"],
    failBuild = false,
  ) =>
    execute(
      process.execPath,
      ["--import", fault, resolve("scripts/install-app.ts"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: root,
          COMMAND_LOG: commands,
          CODEX_REGISTRY_RESPONSE: registryResponse,
          FAIL_BUILD: failBuild ? "1" : "0",
          PATH: tools,
          PACKAGE_FIXTURE: source,
          COPY_MODE: copyMode,
          FAIL_PUBLISH: failPublish ? "1" : "0",
          FAIL_RESTORE: failRestore ? "1" : "0",
          YAKITORI_INSTALL_TARGET: target,
        },
      },
    )
  return {
    applications,
    target,
    run,
    root,
    catalogVersionPath,
    commands: async () =>
      (await readFile(commands, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              command: string
              args: string[]
              cwd: string
            },
        ),
  }
}

it("keeps the installed application and removes staging when copying fails", async () => {
  const { applications, target, run } = await fixture()
  await expect(run("fail")).rejects.toThrow()
  expect(
    await readFile(join(target, "Contents", "MacOS", "Yakitori"), "utf8"),
  ).toBe("old executable")
  expect(await readdir(applications)).toEqual(["Yakitori.app"])
})

it("does not replace the installed application with an incomplete staged bundle", async () => {
  const { applications, target, run } = await fixture()
  await expect(run("incomplete")).rejects.toThrow()
  expect(
    await readFile(join(target, "Contents", "MacOS", "Yakitori"), "utf8"),
  ).toBe("old executable")
  expect(await readdir(applications)).toEqual(["Yakitori.app"])
})

it("replaces a complete application without retaining files from the old bundle", async () => {
  const { applications, target, run } = await fixture()
  await run("success")
  expect(
    await readFile(join(target, "Contents", "MacOS", "Yakitori"), "utf8"),
  ).toBe("new executable")
  expect(await readdir(target)).toEqual(["Contents"])
  expect(await readdir(applications)).toEqual(["Yakitori.app"])
})

it("restores the previous application if publishing the prepared bundle fails", async () => {
  const { applications, target, run } = await fixture()
  await expect(run("success", true)).rejects.toThrow("Publish rename failed")
  expect(
    await readFile(join(target, "Contents", "MacOS", "Yakitori"), "utf8"),
  ).toBe("old executable")
  expect(await readdir(applications)).toEqual(["Yakitori.app"])
})

it("preserves the backup and reports its location if restoration also fails", async () => {
  const { applications, run } = await fixture()
  await expect(run("success", true, true)).rejects.toThrow(
    "previous app could not be restored",
  )
  const names = await readdir(applications)
  expect(names).toHaveLength(1)
  const preserved = names[0]
  expect(preserved).toMatch(/^\.Yakitori\.app-install-/)
  expect(
    await readFile(
      join(
        applications,
        preserved as string,
        "previous.app",
        "Contents",
        "MacOS",
        "Yakitori",
      ),
      "utf8",
    ),
  ).toBe("old executable")
})

it("installs a prepared application when no previous application exists", async () => {
  const { applications, target, run } = await fixture()
  await rm(target, { recursive: true })
  await run("success")
  expect(
    await readFile(join(target, "Contents", "MacOS", "Yakitori"), "utf8"),
  ).toBe("new executable")
  expect(await readdir(applications)).toEqual(["Yakitori.app"])
})

it("syncs the Codex version before packaging the current workspace", async () => {
  const { run, commands, root, target } = await fixture()
  const { stdout } = await run("success", false, false, ["workspace"])
  expect(stdout).toContain("including local changes")
  const calls = await commands()
  expect(calls.filter((call) => call.command === "pnpm")).toEqual([
    { command: "pnpm", args: ["package"], cwd: root },
  ])
  expect(
    calls.some((call) => call.command === "git" || call.command === "gh"),
  ).toBe(false)
  expect(await readFile(join(target, "Contents/MacOS/Yakitori"), "utf8")).toBe(
    "new executable",
  )
  expect(
    JSON.parse(
      await readFile(
        join(target, "Contents/codex-client-version.json"),
        "utf8",
      ),
    ),
  ).toEqual({ clientVersion: "1.1.0" })
})

it.each([
  "offline",
  "unavailable",
  "invalid JSON",
  "prerelease",
])("installs with the checkout's Codex version when the registry response is %s", async (registryResponse) => {
  const { run, target, catalogVersionPath } = await fixture(registryResponse)
  const { stderr } = await run("success", false, false, ["workspace"])
  expect(stderr).toContain(
    "Building with the workspace's Codex catalog client version.",
  )
  const savedVersion = await readFile(catalogVersionPath, "utf8")
  expect(savedVersion).toBe('{"clientVersion":"1.0.0"}\n')
  expect(
    await readFile(join(target, "Contents/codex-client-version.json"), "utf8"),
  ).toBe(savedVersion)
})

it("builds fetched main in an isolated worktree and cleans it after installation", async () => {
  const { run, commands, root } = await fixture()
  const { stdout } = await run("success", false, false, ["main", "--build"])
  expect(stdout).toContain("origin/main@abcdef0")
  const calls = await commands()
  expect(calls.find((call) => call.command === "git")?.args).toEqual([
    "fetch",
    "origin",
    "main",
  ])
  const added = calls.find(
    (call) => call.command === "git" && call.args[1] === "add",
  )
  const worktree = added?.args[3]
  expect(worktree).toBeDefined()
  expect(worktree).not.toBe(root)
  expect(added?.args[4]).toBe("abcdef0123456789")
  expect(calls.filter((call) => call.command === "pnpm")).toEqual([
    { command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: worktree },
    { command: "pnpm", args: ["package"], cwd: worktree },
  ])
  expect(calls.some((call) => call.command === "gh")).toBe(false)
  expect(calls.at(-1)?.args).toEqual([
    "worktree",
    "remove",
    "--force",
    worktree,
  ])
  await expect(readdir(worktree as string)).rejects.toThrow()
})

it.each([
  ["workspace"],
  ["main", "--build"],
])("keeps the installed app when packaging fails for %j", async (...args) => {
  const { run, target, commands } = await fixture()
  await expect(run("success", false, false, args, true)).rejects.toThrow()
  expect(await readFile(join(target, "Contents/MacOS/Yakitori"), "utf8")).toBe(
    "old executable",
  )
  const calls = await commands()
  expect(calls.some((call) => call.command === "ditto")).toBe(false)
  if (args[0] === "main")
    expect(calls.at(-1)?.args.slice(0, 3)).toEqual([
      "worktree",
      "remove",
      "--force",
    ])
})

it.each([
  [],
  ["main", "--local"],
  ["workspace", "--build"],
  ["main", "--unknown"],
])("rejects invalid arguments before invoking external commands: %j", async (...args) => {
  const { run, commands } = await fixture()
  await expect(run("success", false, false, args)).rejects.toThrow("Usage:")
  await expect(commands()).rejects.toThrow()
})
