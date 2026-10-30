import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

export async function prepareComputerFixture(): Promise<string> {
  const source = resolve("native/computer/Tests/Fixture.swift")
  const [bytes, compiler, sdk] = await Promise.all([
    readFile(source),
    run("swiftc", ["--version"]),
    run("xcrun", ["--show-sdk-version"]),
  ])
  const identity = createHash("sha256")
    .update(bytes)
    .update(compiler.stdout)
    .update(sdk.stdout)
    .update(process.arch)
    .digest("hex")
  const executable = resolve("build/computer-fixtures", identity, "fixture")
  try {
    await access(executable)
    console.log("Reusing native fixture (source/compiler/SDK unchanged).")
    return executable
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error
  }
  await mkdir(dirname(executable), { recursive: true })
  const pending = `${executable}.${randomUUID()}`
  try {
    await run("swiftc", [source, "-o", pending])
    await rename(pending, executable)
  } finally {
    await rm(pending, { force: true })
  }
  console.log("Compiled native fixture for changed source/compiler/SDK.")
  return executable
}
