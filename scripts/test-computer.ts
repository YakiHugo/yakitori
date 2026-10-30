import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { McpClient } from "../src/runtime/mcp-client.ts"
import { prepareComputerFixture } from "./computer-fixture.ts"

const run = promisify(execFile)
const core = "native/computer/Sources/ComputerCore"
const executable = resolve("build/computer-contracts")
const { stdout: binPath } = await run("swift", [
  "build",
  "--package-path",
  "native/computer",
  "--scratch-path",
  resolve("build/computer"),
  "-c",
  "release",
  "--show-bin-path",
])
const bridge = join(binPath.trim(), "DisplayBridge.build")
await run("swiftc", [
  "-parse-as-library",
  "-Xcc",
  `-fmodule-map-file=${join(bridge, "module.modulemap")}`,
  ...(await readdir(bridge))
    .filter((name) => name.endsWith(".m.o"))
    .map((name) => join(bridge, name)),
  "-framework",
  "AppKit",
  "-framework",
  "CoreGraphics",
  ...(await readdir(core))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => join(core, name)),
  "native/computer/Tests/Contracts.swift",
  "-o",
  executable,
])
const { stdout } = await run(executable)
process.stdout.write(stdout)

// Exercise the actual signed app through LaunchServices, stdio MCP, and a
// turn-end barrier. This never requests permissions or operates user apps.
const client = new McpClient(
  "computer",
  {
    command:
      process.env.YAKITORI_COMPUTER_EXECUTABLE ??
      resolve(
        "dist/native/Yakitori Computer.app/Contents/MacOS/yakitori-computer",
      ),
    args: ["--mcp"],
  },
  () => {},
  () => {},
  () => {},
)
let helperPid: number | undefined
let fixturePid: number | undefined
const fixtureRoot = await mkdtemp(join(tmpdir(), "yakitori-launch-mcp-"))
try {
  const tools = await client.start()
  const control = tools.find((tool) => tool.name === "control")
  const cleanup = tools.find((tool) => tool.name === "turn_ended")
  if (!control || !cleanup) throw new Error("Native tools are missing.")
  const result = await client.bindTool(control)({ action: "status" })
  if (
    result.isError ||
    typeof result.structuredContent?.accessibility !== "boolean" ||
    typeof result.structuredContent.screenRecording !== "boolean"
  )
    throw new Error("Native permission status is invalid.")
  const pid = result.structuredContent.process_id
  if (typeof pid !== "number")
    throw new Error("The native helper did not identify its process.")
  helperPid = pid
  console.log("Native MCP app permission status:", result.structuredContent)
  const call = client.bindTool(control)
  const app = join(fixtureRoot, "Yakitori Launch Fixture.app")
  const contents = join(app, "Contents")
  await mkdir(join(contents, "MacOS"), { recursive: true })
  await copyFile(
    await prepareComputerFixture(),
    join(contents, "MacOS/fixture"),
  )
  const bundleID = `com.yakitori.launch-fixture.${process.pid}`
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleID}</string>
<key>CFBundleName</key><string>Yakitori Launch Fixture</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  )
  const launched = await call({ action: "launch", app_path: app })
  assert(!launched.isError, JSON.stringify(launched))
  assert.equal(typeof launched.structuredContent?.pid, "number")
  fixturePid = launched.structuredContent?.pid as number
  for (const target of [
    { bundle_id: bundleID },
    { app_name: "Yakitori Launch Fixture" },
  ]) {
    const resolved = await call({ action: "launch", ...target })
    assert(!resolved.isError, JSON.stringify(resolved))
    assert.equal(
      resolved.structuredContent?.pid,
      fixturePid,
      "Repeated launch must resolve the running app",
    )
  }
  const invalid = await call({
    action: "launch",
    app_path: app,
    bundle_id: bundleID,
  })
  assert.equal(invalid.structuredContent?.code, "invalid_arguments")
  const listed = await call({ action: "list" })
  assert(Array.isArray(listed.structuredContent?.displays))
  console.log(
    "MCP launches by path, bundle ID and exact name resolve the same real application.",
  )
  const released = await client.bindTool(cleanup)({})
  if (released.isError) throw new Error("Native turn cleanup failed.")
} finally {
  if (fixturePid !== undefined) process.kill(fixturePid, "SIGTERM")
  await client.close()
  await rm(fixtureRoot, { recursive: true, force: true })
}
console.log(
  "LaunchServices, MCP discovery, permission probing and turn cleanup passed.",
)

if (helperPid !== undefined) {
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      process.kill(helperPid, 0)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        break
      throw error
    }
    if (Date.now() >= deadline)
      throw new Error(
        "The native app remained alive after its MCP connection closed.",
      )
    await new Promise((done) => setTimeout(done, 20))
  }
  console.log("Native app exits after its MCP connection closes.")
}
