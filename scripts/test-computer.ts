import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  chmod,
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
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
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
  "native/computer/Tests/ClipboardContracts.swift",
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
const extraFixturePids = new Set<number>()
const fixtureRoot = await mkdtemp(join(tmpdir(), "yakitori-launch-mcp-"))
type LaunchState = {
  pid: number
  arguments: string[]
  opened_urls: string[]
  reopens: number
}
async function waitForLaunchState(
  path: string,
  matches: (state: LaunchState) => boolean,
): Promise<LaunchState> {
  const deadline = Date.now() + 3_000
  for (;;) {
    let state: LaunchState | undefined
    try {
      state = JSON.parse(await readFile(path, "utf8"))
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error
    }
    if (state && matches(state)) return state
    assert(
      Date.now() < deadline,
      "The real launch fixture did not reach its expected state",
    )
    await new Promise((done) => setTimeout(done, 20))
  }
}
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
  const invalidClipboardImage = await call({
    action: "clipboard",
    clipboard_action: "write",
    format: "image",
    png_base64: Buffer.from("invalid owned PNG fixture").toString("base64"),
  })
  assert.equal(
    invalidClipboardImage.structuredContent?.code,
    "clipboard_image_invalid",
  )
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
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeExtensions</key><array><string>yakitori</string></array><key>CFBundleTypeRole</key><string>Editor</string></dict></array>
</dict></plist>`,
  )
  const initialStatePath = join(fixtureRoot, "initial-state.json")
  const canonicalApp = await realpath(app)
  const launched = await call({
    action: "launch",
    app_path: app,
    arguments: [initialStatePath],
  })
  assert(!launched.isError, JSON.stringify(launched))
  assert.equal(typeof launched.structuredContent?.pid, "number")
  assert.equal(launched.structuredContent?.instance_status, "new")
  assert.equal(launched.structuredContent?.mutation_dispatched, true)
  assert.equal(typeof launched.structuredContent?.launch_time, "number")
  fixturePid = launched.structuredContent?.pid as number
  const launchTime = launched.structuredContent?.launch_time
  const initial = await waitForLaunchState(
    initialStatePath,
    (state) => state.pid === fixturePid,
  )
  // Establish that the fixture observes real reopen events, then ensure
  // discovery/reuse cannot send another one.
  await run("/usr/bin/open", ["-g", "-a", app])
  const reopened = await waitForLaunchState(
    initialStatePath,
    (state) => state.reopens > initial.reopens,
  )
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
    assert.equal(resolved.structuredContent?.instance_status, "existing")
    assert.equal(resolved.structuredContent?.mutation_dispatched, false)
    assert.equal(resolved.structuredContent?.effect, "none")
    assert.equal(resolved.structuredContent?.launch_time, launchTime)
  }
  await new Promise((done) => setTimeout(done, 200))
  const unchanged = await waitForLaunchState(initialStatePath, () => true)
  assert.equal(
    unchanged.reopens,
    reopened.reopens,
    "Binding an existing app must not send reopen",
  )
  const stale = await call({
    action: "launch",
    pid: fixturePid,
    launch_time: Number(launchTime) + 1,
  })
  assert.equal(stale.structuredContent?.code, "stale_target")
  assert.equal(stale.structuredContent?.mutation_dispatched, false)
  assert.equal(stale.structuredContent?.stage, "selection")
  const invalid = await call({
    action: "launch",
    app_path: app,
    bundle_id: bundleID,
  })
  assert.equal(invalid.structuredContent?.code, "invalid_arguments")
  const ignoredArguments = await call({
    action: "launch",
    app_path: app,
    arguments: ["--ignored"],
  })
  assert.equal(
    ignoredArguments.structuredContent?.code,
    "arguments_require_new_instance",
  )
  assert.equal(ignoredArguments.structuredContent?.mutation_dispatched, false)
  // Explicit URL delivery to a unique installation retains the existing
  // process, but is an actual mutation rather than a bind/no-op.
  const document = join(fixtureRoot, "document.yakitori")
  await writeFile(document, "owned launch acceptance fixture")
  const documentUrl = pathToFileURL(await realpath(document)).href
  const delivered = await call({
    action: "launch",
    app_path: app,
    open_urls: [documentUrl],
  })
  assert(!delivered.isError, JSON.stringify(delivered))
  assert.equal(delivered.structuredContent?.pid, fixturePid)
  assert.equal(delivered.structuredContent?.instance_status, "existing")
  assert.equal(delivered.structuredContent?.mutation_dispatched, true)
  await waitForLaunchState(initialStatePath, (state) =>
    state.opened_urls.includes(documentUrl),
  )
  const nextStatePath = join(fixtureRoot, "new-instance-state.json")
  const literal = "literal $(not-a-shell) with spaces"
  const distinct = await call({
    action: "launch",
    app_path: app,
    arguments: [nextStatePath, literal],
    new_instance: true,
  })
  assert(!distinct.isError, JSON.stringify(distinct))
  const distinctPid = distinct.structuredContent?.pid
  assert.equal(typeof distinctPid, "number")
  extraFixturePids.add(distinctPid as number)
  assert.notEqual(distinctPid, fixturePid)
  // New-instance argv has its own output file; URL delivery is verified from
  // actual NSApplication delegate state rather than LaunchServices' callback.
  const openedState = join(fixtureRoot, "opened-state.json")
  const opened = await call({
    action: "launch",
    app_path: app,
    new_instance: true,
    arguments: [openedState, literal],
    open_urls: [documentUrl],
  })
  assert(!opened.isError, JSON.stringify(opened))
  assert.equal(typeof opened.structuredContent?.pid, "number")
  extraFixturePids.add(opened.structuredContent?.pid as number)
  const ambiguous = await call({
    action: "launch",
    app_path: app,
    open_urls: [documentUrl],
  })
  assert.equal(ambiguous.structuredContent?.code, "app_ambiguous")
  assert.equal(ambiguous.structuredContent?.ambiguity, "process")
  assert.equal(ambiguous.structuredContent?.mutation_dispatched, false)
  const processCandidates = ambiguous.structuredContent?.candidates as {
    pid: number
    launch_time: number
    app_path: string
    windows: { window_id: number; title: string }[] | null
  }[]
  assert.deepEqual(
    processCandidates.map((candidate) => candidate.pid).sort((a, b) => a - b),
    [fixturePid, distinctPid, opened.structuredContent?.pid].sort(
      (a, b) => Number(a) - Number(b),
    ),
  )
  assert.deepEqual(
    await Promise.all(
      processCandidates.map((candidate) => realpath(candidate.app_path)),
    ),
    processCandidates.map(() => canonicalApp),
  )
  const chosen = processCandidates.find(
    (candidate) => candidate.pid === fixturePid,
  )
  assert(chosen)
  assert.equal(chosen.launch_time, launchTime)
  assert(chosen.windows?.some((window) => window.window_id > 0))
  const bound = await call({
    action: "launch",
    pid: chosen.pid,
    launch_time: chosen.launch_time,
  })
  assert(!bound.isError, JSON.stringify(bound))
  assert.equal(bound.structuredContent?.pid, fixturePid)
  assert.equal(bound.structuredContent?.mutation_dispatched, false)
  const processOpen = await call({
    action: "launch",
    pid: chosen.pid,
    launch_time: chosen.launch_time,
    open_urls: [documentUrl],
  })
  assert.equal(processOpen.structuredContent?.code, "process_open_unsupported")
  assert.equal(processOpen.structuredContent?.mutation_dispatched, false)
  for (const [path, expectedPid, expectedUrls] of [
    [nextStatePath, distinctPid, []],
    [openedState, opened.structuredContent?.pid, [documentUrl]],
  ] as const) {
    const state = await waitForLaunchState(
      path,
      (state) => state.opened_urls.length === expectedUrls.length,
    )
    assert.equal(state.pid, expectedPid)
    assert.deepEqual(state.arguments, [path, literal])
    assert.deepEqual(state.opened_urls, expectedUrls)
  }
  assert.deepEqual(
    (await waitForLaunchState(initialStatePath, () => true)).opened_urls,
    [documentUrl],
    "Ambiguous or unsupported delivery must not open another document",
  )
  // A second installation sharing both name and bundle ID must be returned
  // as an installation candidate, rather than silently substituted.
  const otherApp = join(fixtureRoot, "other", "Yakitori Launch Fixture.app")
  await mkdir(join(otherApp, "Contents", "MacOS"), { recursive: true })
  await copyFile(
    join(contents, "MacOS/fixture"),
    join(otherApp, "Contents", "MacOS/fixture"),
  )
  await copyFile(
    join(contents, "Info.plist"),
    join(otherApp, "Contents", "Info.plist"),
  )
  const other = await call({
    action: "launch",
    app_path: otherApp,
    new_instance: true,
    arguments: [join(fixtureRoot, "other-state.json")],
  })
  assert(!other.isError, JSON.stringify(other))
  extraFixturePids.add(other.structuredContent?.pid as number)
  for (const target of [
    { app_name: "Yakitori Launch Fixture" },
    { bundle_id: bundleID },
  ]) {
    const multiple = await call({ action: "launch", ...target })
    assert.equal(multiple.structuredContent?.code, "app_ambiguous")
    assert.equal(multiple.structuredContent?.ambiguity, "installation")
    assert.equal(multiple.structuredContent?.mutation_dispatched, false)
    assert.deepEqual(
      (
        await Promise.all(
          (
            multiple.structuredContent?.candidates as { app_path: string }[]
          ).map((candidate) => realpath(candidate.app_path)),
        )
      ).sort(),
      [canonicalApp, await realpath(otherApp)].sort(),
    )
  }
  const brokenApp = join(fixtureRoot, "Broken.app")
  await mkdir(join(brokenApp, "Contents", "MacOS"), { recursive: true })
  await writeFile(
    join(brokenApp, "Contents", "Info.plist"),
    '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.yakitori.broken-launch</string><key>CFBundleExecutable</key><string>broken</string></dict></plist>',
  )
  const brokenExecutable = join(brokenApp, "Contents", "MacOS", "broken")
  await writeFile(brokenExecutable, "not an executable image")
  await chmod(brokenExecutable, 0o755)
  const failed = await call({ action: "launch", app_path: brokenApp })
  assert.equal(failed.isError, true)
  assert.equal(failed.structuredContent?.code, "launch_failed")
  assert.equal(failed.structuredContent?.mutation_dispatched, true)
  assert.equal(failed.structuredContent?.effect, "unverified")
  assert.equal(failed.structuredContent?.stage, "dispatch")
  assert.equal(
    await realpath(
      (failed.structuredContent?.requested as { app_path: string }).app_path,
    ),
    await realpath(brokenApp),
  )
  const listed = await call({ action: "list" })
  assert(Array.isArray(listed.structuredContent?.displays))
  const listedWindows = (
    listed.structuredContent?.windows as {
      pid: number
      launch_time: number
    }[]
  ).filter((window) => window.pid === fixturePid)
  assert(
    listedWindows.length > 0,
    "Discovery must retain the running fixture's windows",
  )
  assert(
    listedWindows.every((window) => window.launch_time === launchTime),
    "Discovery and launch must use the same kernel process identity",
  )
  console.log(
    "MCP launches by path, bundle ID and exact name resolve the same real application.",
  )
  console.log(
    "LaunchServices passes literal argv, creates distinct processes and delivers documents to the explicit application.",
  )
  const released = await client.bindTool(cleanup)({})
  if (released.isError) throw new Error("Native turn cleanup failed.")
} finally {
  if (fixturePid !== undefined) process.kill(fixturePid, "SIGTERM")
  for (const pid of extraFixturePids) process.kill(pid, "SIGTERM")
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
// Compile the independent WebKit fixture in macOS CI without requiring GUI/TCC.
await prepareComputerFixture(resolve("native/computer/Tests/WebFixture.swift"))
