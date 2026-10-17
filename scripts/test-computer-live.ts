import assert from "node:assert/strict"
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { release, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import { McpClient } from "../src/runtime/mcp-client.ts"

const { values } = parseArgs({
  options: {
    repeat: { type: "string", default: "1" },
    report: { type: "string", default: "test-results/computer-live.json" },
  },
})
const repeats = Number(values.repeat)
// A safety boundary for this interactive local test runner, not a product quota.
// Twenty repetitions already exercise hundreds of GUI effects on the host Mac.
assert(
  Number.isInteger(repeats) && repeats > 0 && repeats <= 20,
  "repeat must be between 1 and 20",
)
const reportPath = resolve(values.report)
const executable =
  process.env.YAKITORI_COMPUTER_EXECUTABLE ??
  resolve("dist/native/Yakitori Computer.app/Contents/MacOS/yakitori-computer")
const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "yakitori-native-live-"))
type Row = {
  case: string
  iteration: number
  status: "passed" | "failed"
  durationMs: number
  error?: string
}
const rows: Row[] = []
const report = {
  suite: "macos-native-fixture",
  model: null,
  scope:
    "Scripted real-AppKit driver acceptance and latency; not an agent/model benchmark.",
  startedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch} ${release()}`,
  executable,
  driverSha256: createHash("sha256")
    .update(await readFile(executable))
    .digest("hex"),
  repetitions: repeats,
  status: "running",
  rows,
  permissions: {} as Record<string, unknown>,
  error: undefined as string | undefined,
}
const client = new McpClient(
  "computer",
  { command: executable, args: ["--mcp"] },
  () => {},
  () => {},
  () => {},
)
let fixture: ChildProcess | undefined
let failure: unknown
try {
  const tools = await client.start()
  const tool = tools.find((entry) => entry.name === "control")
  const cleanup = tools.find((entry) => entry.name === "turn_ended")
  assert(tool && cleanup, "Native computer tools are unavailable")
  const call = client.bindTool(tool)
  const status = await call({ action: "status" })
  report.permissions = status.structuredContent ?? {}
  if (
    !report.permissions.accessibility ||
    !report.permissions.screenRecording
  ) {
    report.status = "blocked"
    throw new Error(
      "macOS permission required: enable Accessibility and Screen Recording for Yakitori Computer. No GUI cases executed.",
    )
  }
  const fixtureExecutable = join(root, "fixture")
  await run("swiftc", [
    "native/computer/Tests/Fixture.swift",
    "-o",
    fixtureExecutable,
  ])
  for (let iteration = 1; iteration <= repeats; iteration++) {
    const stateFile = join(root, `state-${iteration}.json`)
    fixture = spawn(fixtureExecutable, [stateFile], { stdio: "ignore" })
    await once(fixture, "spawn")
    const pid = fixture.pid
    assert(pid !== undefined, "The native fixture did not start")
    type State = {
      count: number
      first: string
      second: string
      height: number
      moves: number
      visible: boolean
      dragging: boolean
      mouse_down: number
      mouse_up: number
    }
    const state = async (): Promise<State> =>
      JSON.parse(await readFile(stateFile, "utf8"))
    const waitFor = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 5_000
      while (!(await check())) {
        if (fixture?.exitCode !== null)
          throw new Error(
            "The fixture exited before the expected application state",
          )
        if (Date.now() >= deadline)
          throw new Error(
            "The fixture did not reach its expected application state",
          )
        await new Promise((done) => setTimeout(done, 10))
      }
    }
    let windowID: number | undefined
    await waitFor(async () => {
      const listed = await call({ action: "list" })
      const windows = listed.structuredContent?.windows as {
        pid: number
        window_id: number
      }[]
      windowID = windows.find((window) => window.pid === pid)?.window_id
      return windowID !== undefined
    })
    const observe = async () => {
      const result = await call({ action: "observe", pid, window_id: windowID })
      assert(!result.isError, JSON.stringify(result.structuredContent))
      return result
    }
    type Observation = Awaited<ReturnType<typeof observe>>
    const element = (observation: Observation, label: string) => {
      const elements = observation.structuredContent?.elements as {
        element: number
        title?: string
        description?: string
      }[]
      const found = elements.find(
        (entry) => entry.title === label || entry.description === label,
      )
      assert(found, `Missing accessibility control: ${label}`)
      return found.element
    }
    const input = async (
      action: string,
      observation: Observation,
      args: Record<string, unknown> = {},
    ) => {
      const result = await call({
        action,
        snapshot_id: observation.structuredContent?.snapshot_id,
        ...args,
      })
      assert(!result.isError, JSON.stringify(result.structuredContent))
      return result
    }
    const check = async (name: string, execute: () => Promise<void>) => {
      const started = performance.now()
      try {
        await execute()
        rows.push({
          case: name,
          iteration,
          status: "passed",
          durationMs: performance.now() - started,
        })
        console.log(`PASS ${iteration}/${repeats} ${name}`)
      } catch (error) {
        rows.push({
          case: name,
          iteration,
          status: "failed",
          durationMs: performance.now() - started,
          error: String(error),
        })
        throw error
      }
    }
    await check("window screenshot and actual PNG geometry", async () => {
      const observed = await observe()
      const image = observed.content.find((content) => content.type === "image")
      assert(image?.type === "image")
      const png = Buffer.from(image.data, "base64")
      assert.equal(
        png.readUInt32BE(16),
        observed.structuredContent?.image_width,
      )
      assert.equal(
        png.readUInt32BE(20),
        observed.structuredContent?.image_height,
      )
      assert.equal(png.readUInt32BE(16), 500)
      assert.equal(png.readUInt32BE(20), (await state()).height)
    })
    await check("AX press changes the application's own state", async () => {
      const observed = await observe()
      await input("press", observed, {
        element: element(observed, "Increment"),
      })
      await waitFor(async () => (await state()).count === 1)
    })
    await check(
      "consumed observation cannot repeat a side effect",
      async () => {
        const observed = await observe()
        const button = element(observed, "Increment")
        await input("press", observed, { element: button })
        await waitFor(async () => (await state()).count === 2)
        const result = await call({
          action: "press",
          snapshot_id: observed.structuredContent?.snapshot_id,
          element: button,
        })
        assert.equal(result.isError, true)
        assert.equal(result.structuredContent?.code, "stale_snapshot")
        assert.equal((await state()).count, 2)
      },
    )
    await check("Unicode input switches to the addressed field", async () => {
      let observed = await observe()
      await input("type", observed, {
        element: element(observed, "First input"),
        text: "Keep this unchanged",
      })
      await waitFor(async () => (await state()).first === "Keep this unchanged")
      observed = await observe()
      await input("type", observed, {
        element: element(observed, "Second input"),
        text: "Yakitori 验证 😀",
      })
      await waitFor(async () => (await state()).second === "Yakitori 验证 😀")
      assert.equal((await state()).first, "Keep this unchanged")
    })
    await check(
      "select-all and replacement commit through real keyboard events",
      async () => {
        const observed = await observe()
        await input("type", observed, {
          element: element(observed, "Second input"),
          text: "Replaced 中文",
          replace: true,
        })
        await waitFor(async () => (await state()).second === "Replaced 中文")
        assert.equal((await state()).first, "Keep this unchanged")
      },
    )
    await check(
      "per-process pixel click reaches the addressed window",
      async () => {
        const observed = await observe()
        await input("click", observed, {
          x: 100,
          y: (await state()).height - 118,
        })
        await waitFor(async () => (await state()).count === 3)
      },
    )
    await check(
      "explicit foreground pixel click reaches the button",
      async () => {
        const observed = await observe()
        // Fixture's button centre is (100,118) AppKit points from the bottom.
        await input("click", observed, {
          x: 100,
          y: (await state()).height - 118,
          delivery: "foreground",
        })
        await waitFor(async () => (await state()).count === 4)
      },
    )
    await check("cancelled drag releases its held mouse button", async () => {
      const observed = await observe()
      const controller = new AbortController()
      const dragging = call(
        {
          action: "drag",
          snapshot_id: observed.structuredContent?.snapshot_id,
          x: 280,
          y: (await state()).height - 70,
          to_x: 420,
          to_y: (await state()).height - 70,
          delivery: "foreground",
        },
        controller.signal,
      )
      // Attach the rejection handler before observing the cross-process barrier.
      const outcome = dragging.then(
        () => "completed",
        () => "cancelled",
      )
      await waitFor(async () => (await state()).mouse_down === 1)
      controller.abort()
      assert.equal(await outcome, "cancelled")
      assert(!(await client.bindTool(cleanup)({})).isError)
      await waitFor(
        async () => !(await state()).dragging && (await state()).mouse_up === 1,
      )
    })
    await check(
      "cancelled typing stops and permits the next native action",
      async () => {
        const observed = await observe()
        const controller = new AbortController()
        const typing = call(
          {
            action: "type",
            snapshot_id: observed.structuredContent?.snapshot_id,
            element: element(observed, "Second input"),
            text: "x".repeat(100_000),
            replace: true,
          },
          controller.signal,
        )
        const outcome = typing.then(
          () => "completed",
          () => "cancelled",
        )
        await waitFor(async () => (await state()).second.startsWith("xxx"))
        controller.abort()
        assert.equal(await outcome, "cancelled")
        assert(!(await client.bindTool(cleanup)({})).isError)
        const next = await observe()
        assert((await state()).second.length < 100_000)
        await input("press", next, { element: element(next, "Increment") })
        await waitFor(async () => (await state()).count === 5)
      },
    )
    await check("moved window rejects the previous observation", async () => {
      const observed = await observe()
      process.kill(pid, "SIGUSR1")
      await waitFor(async () => (await state()).moves === 1)
      const result = await call({
        action: "press",
        snapshot_id: observed.structuredContent?.snapshot_id,
        element: element(observed, "Increment"),
      })
      assert.equal(result.structuredContent?.code, "stale_snapshot")
      assert.equal((await state()).count, 5)
    })
    await check("closed window rejects the previous observation", async () => {
      const observed = await observe()
      process.kill(pid, "SIGUSR2")
      await waitFor(async () => !(await state()).visible)
      const result = await call({
        action: "press",
        snapshot_id: observed.structuredContent?.snapshot_id,
        element: element(observed, "Increment"),
      })
      assert.equal(result.structuredContent?.code, "stale_snapshot")
      assert.equal((await state()).count, 5)
    })
    const exited = once(fixture, "exit")
    fixture.kill("SIGTERM")
    await exited
    fixture = undefined
  }
  report.status = "passed"
} catch (error) {
  failure = error
  if (report.status !== "blocked") report.status = "failed"
  report.error = String(error)
} finally {
  if (fixture !== undefined && fixture.exitCode === null) {
    const exited = once(fixture, "exit")
    fixture.kill("SIGTERM")
    await exited
  }
  await client.close()
  await rm(root, { recursive: true, force: true })
  const summaries = [...new Set(rows.map((row) => row.case))].map((name) => {
    const cases = rows.filter((row) => row.case === name)
    const times = cases.map((row) => row.durationMs).sort((a, b) => a - b)
    return {
      case: name,
      passed: cases.filter((row) => row.status === "passed").length,
      runs: cases.length,
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    }
  })
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(
    reportPath,
    `${JSON.stringify(
      { ...report, completedAt: new Date().toISOString(), summaries },
      null,
      2,
    )}\n`,
  )
  console.log(
    `Report: ${reportPath} (${report.status}, ${rows.length} executed cases)`,
  )
}
if (failure !== undefined) throw failure
