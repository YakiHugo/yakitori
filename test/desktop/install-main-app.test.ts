import { execFile } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-installer-test-"))
  temporary.push(root)
  const tools = join(root, "tools")
  const applications = join(root, "Applications")
  const source = join(root, "source.app")
  const target = join(applications, "Yakitori.app")
  await mkdir(tools)
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
const { cpSync, mkdirSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
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
  for (const name of ["gh", "tar", "ditto", "xattr"])
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
`,
  )
  const run = (copyMode: string, failPublish = false, failRestore = false) =>
    execute(
      process.execPath,
      ["--import", fault, resolve("scripts/install-main-app.ts")],
      {
        env: {
          ...process.env,
          PATH: tools,
          PACKAGE_FIXTURE: source,
          COPY_MODE: copyMode,
          FAIL_PUBLISH: failPublish ? "1" : "0",
          FAIL_RESTORE: failRestore ? "1" : "0",
          YAKITORI_INSTALL_TARGET: target,
        },
      },
    )
  return { applications, target, run }
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
