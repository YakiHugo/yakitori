import assert from "node:assert/strict"
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { release, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import { McpClient } from "../src/runtime/mcp-client.ts"

const { values } = parseArgs({
  options: {
    repeat: { type: "string", default: "1" },
    report: { type: "string", default: "test-results/computer-live.json" },
    direct: { type: "boolean", default: false },
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
  transport: values.direct ? "inherited-host" : "launch-services",
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
  { command: executable, args: values.direct ? [] : ["--mcp"] },
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
    fixture = spawn(fixtureExecutable, [stateFile, "--multi-window"], {
      stdio: "ignore",
    })
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
      window_id: number
      secondary_window_id: number
      active: boolean
      foreground_pid: number
      selection_location: number
      selection_length: number
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
            `The fixture did not reach its expected application state: ${JSON.stringify(await state())}`,
          )
        await new Promise((done) => setTimeout(done, 10))
      }
    }
    let windowID: number | undefined
    await waitFor(async () => {
      try {
        await access(stateFile)
        return true
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return false
        throw error
      }
    })
    await waitFor(async () => {
      const listed = await call({ action: "list" })
      const windows = listed.structuredContent?.windows as {
        pid: number
        window_id: number
      }[]
      const primary = (await state()).window_id
      windowID = windows.find(
        (window) => window.pid === pid && window.window_id === primary,
      )?.window_id
      return windowID !== undefined
    })
    const observe = async () => {
      let result: Awaited<ReturnType<typeof call>> | undefined
      // A read may race WindowServer publication/animation. Retry only that
      // explicit stale-read outcome, within the existing fixture wait boundary.
      // Inputs below are always issued once, including failed deliveries.
      await waitFor(async () => {
        const next = await call({ action: "observe", pid, window_id: windowID })
        if (next.isError && next.structuredContent?.code === "stale_snapshot")
          return false
        assert(!next.isError, JSON.stringify(next.structuredContent))
        result = next
        return true
      })
      assert(result)
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
          error: `${String(error)}; fixture=${JSON.stringify(await state())}`,
        })
        throw error
      }
    }
    // WindowServer publishes a new window before ScreenCaptureKit necessarily
    // exposes its content or finishes the launch animation. Require the owned
    // fixture's actual AppKit geometry to stay stable before measuring it.
    let stableSince: number | undefined
    await waitFor(async () => {
      const ready = await call({
        action: "observe",
        pid,
        window_id: windowID,
        mode: "vision",
      })
      if (
        ready.isError &&
        ["window_not_found", "stale_snapshot"].includes(
          String(ready.structuredContent?.code),
        )
      ) {
        stableSince = undefined
        return false
      }
      assert(!ready.isError, JSON.stringify(ready.structuredContent))
      const frame = ready.structuredContent?.frame as {
        width: number
        height: number
      }
      if (frame.width !== 500 || frame.height !== (await state()).height) {
        stableSince = undefined
        return false
      }
      stableSince ??= performance.now()
      return performance.now() - stableSince >= 250
    })
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
    await check(
      "observation modes separate AX text from screenshot pixels",
      async () => {
        const ax = await call({
          action: "observe",
          pid,
          window_id: windowID,
          mode: "ax",
        })
        assert(!ax.isError, JSON.stringify(ax.structuredContent))
        assert(!ax.content.some((part) => part.type === "image"))
        assert.equal(ax.structuredContent?.image_width, undefined)
        element(ax, "First input")
        const refused = await call({
          action: "click",
          snapshot_id: ax.structuredContent?.snapshot_id,
          x: 10,
          y: 10,
        })
        assert.equal(refused.structuredContent?.code, "coordinates_unavailable")
        const replacement = await call({
          action: "type",
          snapshot_id: ax.structuredContent?.snapshot_id,
          text: "must not arrive",
          replace: true,
          delivery: "foreground",
        })
        assert.equal(replacement.structuredContent?.code, "invalid_arguments")
        assert.equal((await state()).first, "")
        assert.equal((await state()).second, "")
        const vision = await call({
          action: "observe",
          pid,
          window_id: windowID,
          mode: "vision",
        })
        assert(!vision.isError, JSON.stringify(vision.structuredContent))
        assert(vision.content.some((part) => part.type === "image"))
        assert.deepEqual(vision.structuredContent?.elements, [])
      },
    )
    await check(
      "application scope includes both windows in one image and AX index",
      async () => {
        const app = await call({
          action: "observe",
          scope: "app",
          mode: "both",
          pid,
        })
        assert(!app.isError, JSON.stringify(app.structuredContent))
        const image = app.content.find((part) => part.type === "image")
        assert(image?.type === "image")
        assert.equal(Buffer.from(image.data, "base64").readUInt32BE(16), 800)
        const rows = app.structuredContent?.elements as {
          element: number
          window_id: number
        }[]
        const secondary = element(app, "Secondary increment")
        assert.equal(
          rows.find((row) => row.element === secondary)?.window_id,
          (await state()).secondary_window_id,
        )
        element(app, "First input")
        const before = (await state()).count
        await input("press", app, { element: secondary })
        await waitFor(async () => (await state()).count === before + 1)
      },
    )
    await check(
      "failed observation discards the previous input ticket",
      async () => {
        const observed = await observe()
        const invalid = await call({ action: "observe", scope: "app" })
        assert.equal(invalid.structuredContent?.code, "invalid_arguments")
        const before = (await state()).count
        const refused = await call({
          action: "press",
          snapshot_id: observed.structuredContent?.snapshot_id,
          element: element(observed, "Increment"),
        })
        assert.equal(refused.structuredContent?.code, "stale_snapshot")
        assert.equal((await state()).count, before)
      },
    )
    await check(
      "screen observation names an active display and keeps modes distinct",
      async () => {
        const listed = await call({ action: "list" })
        const displays = listed.structuredContent?.displays as {
          display_id: number
          main: boolean
        }[]
        const main = displays.find((display) => display.main)
        assert(main)
        for (const mode of ["ax", "vision", "both"]) {
          const screen = await call({
            action: "observe",
            scope: "screen",
            mode,
            display_id: main.display_id,
          })
          assert(!screen.isError, JSON.stringify(screen.structuredContent))
          assert.equal(screen.structuredContent?.display_id, main.display_id)
          assert.equal(
            screen.content.some((part) => part.type === "image"),
            mode !== "ax",
          )
          if (mode === "vision")
            assert.deepEqual(screen.structuredContent?.elements, [])
        }
      },
    )
    await check("AX press changes the application's own state", async () => {
      const observed = await observe()
      await input("press", observed, {
        element: element(observed, "Increment"),
      })
      await waitFor(async () => (await state()).count === 2)
    })
    await check(
      "consumed observation cannot repeat a side effect",
      async () => {
        const observed = await observe()
        const button = element(observed, "Increment")
        await input("press", observed, { element: button })
        await waitFor(async () => (await state()).count === 3)
        const result = await call({
          action: "press",
          snapshot_id: observed.structuredContent?.snapshot_id,
          element: button,
        })
        assert.equal(result.isError, true)
        assert.equal(result.structuredContent?.code, "stale_snapshot")
        assert.equal((await state()).count, 3)
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
      "replacement confirms the complete selection before real text events",
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
        const foregroundPID = (await state()).foreground_pid
        await input("click", observed, {
          x: 100,
          y: (await state()).height - 118,
        })
        await waitFor(async () => (await state()).count === 4)
        assert.equal(
          (await state()).foreground_pid,
          foregroundPID,
          "Background input must preserve the system's foreground application",
        )
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
        await waitFor(async () => (await state()).count === 5)
      },
    )
    await check(
      "foreground shortcut selects text and releases modifiers",
      async () => {
        let observed = await observe()
        await input("key", observed, {
          element: element(observed, "Second input"),
          key: "CMD+A",
          delivery: "foreground",
        })
        observed = await observe()
        await input("type", observed, {
          element: element(observed, "Second input"),
          text: "Shortcut 中文",
          delivery: "foreground",
        })
        await waitFor(async () => (await state()).second === "Shortcut 中文")
      },
    )
    await check(
      "AX value writes change the application's own text",
      async () => {
        const observed = await observe()
        const result = await input("set_value", observed, {
          element: element(observed, "Second input"),
          text: "alpha 😀 alpha",
        })
        assert.equal(result.structuredContent?.effect, "confirmed")
        await waitFor(async () => (await state()).second === "alpha 😀 alpha")
      },
    )
    await check(
      "ambiguous selection refuses and contextual Unicode selection replaces only its match",
      async () => {
        let observed = await observe()
        const refused = await call({
          action: "select_text",
          snapshot_id: observed.structuredContent?.snapshot_id,
          element: element(observed, "Second input"),
          text: "alpha",
        })
        assert.equal(refused.structuredContent?.code, "selection_ambiguous")
        observed = await observe()
        await input("select_text", observed, {
          element: element(observed, "Second input"),
          text: "alpha",
          prefix: "😀 ",
        })
        await waitFor(
          async () =>
            (await state()).selection_location === 9 &&
            (await state()).selection_length === 5,
        )
        observed = await observe()
        await input("type", observed, {
          element: element(observed, "Second input"),
          text: "omega",
        })
        await waitFor(async () => (await state()).second === "alpha 😀 omega")
        observed = await observe()
        await input("select_text", observed, {
          element: element(observed, "Second input"),
          text: "alpha",
          selection_type: "cursor_after",
        })
        observed = await observe()
        await input("type", observed, {
          element: element(observed, "Second input"),
          text: "-",
        })
        await waitFor(async () => (await state()).second === "alpha- 😀 omega")
      },
    )
    await check(
      "advertised AX actions execute and unavailable actions refuse",
      async () => {
        let observed = await observe()
        const refused = await call({
          action: "perform_action",
          snapshot_id: observed.structuredContent?.snapshot_id,
          element: element(observed, "Increment"),
          action_name: "AXNotAnAction",
        })
        assert.equal(refused.structuredContent?.code, "action_unavailable")
        observed = await observe()
        await input("perform_action", observed, {
          element: element(observed, "Increment"),
          action_name: "AXPress",
        })
        await waitFor(async () => (await state()).count === 6)
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
        await waitFor(async () => (await state()).count === 7)
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
      assert.equal((await state()).count, 7)
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
      assert.equal((await state()).count, 7)
      // The next case captures the whole display. Let WindowServer publish the
      // completed close rather than including its disappearing surface.
      await waitFor(async () => {
        const listed = await call({ action: "list" })
        return !(
          listed.structuredContent?.windows as { window_id: number }[]
        ).some((window) => window.window_id === windowID)
      })
    })
    await check(
      "screen pixels require foreground and reach the selected display target",
      async () => {
        const listed = await call({ action: "list" })
        const windows = listed.structuredContent?.windows as {
          window_id: number
          frame: { x: number; y: number; width: number; height: number }
        }[]
        const secondaryID = (await state()).secondary_window_id
        const secondary = windows.find(
          (window) => window.window_id === secondaryID,
        )
        assert(secondary)
        const screen = await call({
          action: "observe",
          scope: "screen",
          mode: "vision",
        })
        assert(!screen.isError, JSON.stringify(screen.structuredContent))
        const frame = screen.structuredContent?.frame as {
          x: number
          y: number
          width: number
          height: number
        }
        const width = screen.structuredContent?.image_width as number
        const height = screen.structuredContent?.image_height as number
        // Secondary button centre: (110, 78) AppKit points from window bottom.
        const x = ((secondary.frame.x + 110 - frame.x) * width) / frame.width
        const y =
          ((secondary.frame.y + secondary.frame.height - 78 - frame.y) *
            height) /
          frame.height
        const refused = await call({
          action: "click",
          snapshot_id: screen.structuredContent?.snapshot_id,
          x,
          y,
        })
        assert.equal(refused.structuredContent?.code, "foreground_required")
        assert.equal((await state()).count, 7)
        await input("click", screen, { x, y, delivery: "foreground" })
        await waitFor(async () => (await state()).count === 8)
      },
    )
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
