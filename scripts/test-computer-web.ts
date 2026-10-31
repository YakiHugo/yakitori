import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { isDeepStrictEqual, parseArgs } from "node:util"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { McpClient } from "../src/runtime/mcp-client.ts"
import { prepareComputerFixture } from "./computer-fixture.ts"

const { values } = parseArgs({
  options: {
    engine: { type: "string", default: "both" },
    delivery: { type: "string", default: "background" },
    case: { type: "string" },
    report: { type: "string", default: "test-results/computer-web.json" },
  },
})
assert(["both", "webkit", "electron"].includes(values.engine))
assert(["background", "foreground"].includes(values.delivery))
assert.equal(
  process.platform,
  "darwin",
  "Native web-input acceptance requires macOS",
)
const root = await mkdtemp(join(tmpdir(), "yakitori-web-input-"))
const multipleWindows = values.case?.includes("two web windows") === true
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
const rows: {
  engine: string
  case: string
  durationMs: number
  status: string
  state?: State | undefined
  secondaryState?: State | undefined
  evidence?: Record<string, unknown> | undefined
}[] = []
type State = {
  pid: number
  window_id?: number
  ready: boolean
  first: string
  second: string
  count: number
  scrollTop: number
  drops: number
  dragStarts: number
  events: string[]
}
let failure: unknown
try {
  const tools = await client.start()
  const control = tools.find((tool) => tool.name === "control")
  const cleanup = tools.find((tool) => tool.name === "turn_ended")
  assert(control && cleanup)
  const call = client.bindTool(control)
  const permissions = (await call({ action: "status" })).structuredContent
  assert(
    permissions?.accessibility && permissions.screenRecording,
    "Existing macOS helper grants need refreshing",
  )
  for (const engine of values.engine === "both"
    ? ["webkit", "electron"]
    : [values.engine]) {
    const output = join(root, `${engine}.json`)
    const secondOutput = join(root, `${engine}-second.json`)
    // Keep owned app resources in its disposable directory. LaunchServices
    // apps must not need a new Documents-folder privacy grant for test sources.
    const page = join(root, "web-fixture.html")
    await copyFile(resolve("native/computer/Tests/WebFixture.html"), page)
    let command: string
    let args: string[]
    if (engine === "webkit") {
      const app = join(root, "Yakitori WebKit Fixture.app")
      const contents = join(app, "Contents")
      await mkdir(join(contents, "MacOS"), { recursive: true })
      await copyFile(
        await prepareComputerFixture(
          resolve("native/computer/Tests/WebFixture.swift"),
        ),
        join(contents, "MacOS/fixture"),
      )
      await writeFile(
        join(contents, "Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.yakitori.webkit-fixture.${process.pid}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`,
      )
      command = join(contents, "MacOS/fixture")
      args = [output, page]
    } else {
      const executable: unknown = (await import("electron")).default
      assert(typeof executable === "string")
      command = executable
      const script = join(root, "electron-fixture.cjs")
      await copyFile(
        resolve("native/computer/Tests/ElectronFixture.cjs"),
        script,
      )
      args = [script, output, page]
    }
    if (multipleWindows) args.push(secondOutput)
    let child: ReturnType<typeof spawn> | undefined
    let nativePID: number | undefined
    let errors = ""
    let current: State | undefined
    let lastAction: Record<string, unknown> | undefined
    let focusPID: number | undefined
    let backgroundPID: number | undefined
    const state = async (file = output) => {
      try {
        const observed = JSON.parse(await readFile(file, "utf8")) as State
        if (file === output) current = observed
        return observed
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined
        throw error
      }
    }
    const waitFor = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000
      while (!(await predicate())) {
        assert(
          child === undefined ||
            (child.exitCode === null && child.signalCode === null),
          `Fixture exited: ${errors}`,
        )
        assert(
          Date.now() < deadline,
          `Fixture state timeout: ${JSON.stringify(current)} ${errors}`,
        )
        await new Promise((done) => setTimeout(done, 20))
      }
    }
    try {
      if (engine === "webkit") {
        const launched = await call({
          action: "launch",
          app_path: resolve(command, "../../.."),
          arguments: args,
          new_instance: true,
          delivery: "foreground",
        })
        assert(!launched.isError, JSON.stringify(launched.structuredContent))
        assert.equal(typeof launched.structuredContent?.pid, "number")
        nativePID = launched.structuredContent?.pid as number
      } else {
        child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })
        child.stderr?.on("data", (chunk) => {
          errors = (errors + String(chunk)).slice(-4000)
        })
      }
      await waitFor(async () => (await state())?.ready === true)
      assert(current)
      const pid = current.pid
      // Page JavaScript can report ready before the app's startup activation
      // reaches WindowServer. Let that transition finish before handing focus
      // to the owned background-test window.
      if (engine === "electron")
        await waitFor(
          async () =>
            (await call({ action: "status" })).structuredContent
              ?.frontmost_pid === pid,
        )
      // A separate owned native app holds focus for actual background tests.
      const focusApp = join(root, "Yakitori Focus Fixture.app", "Contents")
      await mkdir(join(focusApp, "MacOS"), { recursive: true })
      await copyFile(
        await prepareComputerFixture(
          resolve("native/computer/Tests/WebFixture.swift"),
        ),
        join(focusApp, "MacOS/fixture"),
      )
      await writeFile(
        join(focusApp, "Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.yakitori.focus-fixture.${process.pid}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      )
      const activated = await call({
        action: "launch",
        app_path: resolve(focusApp, ".."),
        arguments: [join(root, `${engine}-focus.txt`), "--focus-holder"],
        new_instance: true,
        delivery: "foreground",
      })
      assert(!activated.isError, JSON.stringify(activated.structuredContent))
      assert.equal(typeof activated.structuredContent?.pid, "number")
      focusPID = activated.structuredContent?.pid as number
      await waitFor(async () => {
        try {
          return (
            Number(
              await readFile(join(root, `${engine}-focus.txt`), "utf8"),
            ) === focusPID
          )
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
      const focused = await call({
        action: "window",
        window_action: "activate",
        pid: focusPID,
        launch_time: activated.structuredContent?.launch_time,
      })
      assert(!focused.isError, JSON.stringify(focused.structuredContent))
      try {
        await waitFor(async () => {
          const active = (await call({ action: "status" })).structuredContent
            ?.frontmost_pid
          if (typeof active !== "number" || active === pid) return false
          // The user may keep their own app frontmost. Background acceptance
          // requires the target to stay inactive and must not fight that choice.
          backgroundPID = active
          return true
        })
      } catch (error) {
        console.error("Focus setup failed", {
          focusPID,
          activated: activated.structuredContent,
          focused: focused.structuredContent,
          status: (await call({ action: "status" })).structuredContent,
        })
        throw error
      }
      let windowID: number | undefined
      await waitFor(async () => {
        const listed = await call({ action: "list" })
        const windows = (
          listed.structuredContent?.windows as {
            pid: number
            window_id: number
            title: string
          }[]
        ).filter((row) => row.pid === pid)
        assert(
          windows.length <= (multipleWindows ? 2 : 1),
          "Unexpected fixture window",
        )
        if (multipleWindows && windows.length !== 2) return false
        windowID = windows.find((row) => !row.title.endsWith(" 2"))?.window_id
        return windowID !== undefined
      })
      type Row = {
        element: number
        role?: string
        title?: string
        description?: string
        frame?: { x: number; y: number; width: number; height: number }
      }
      const observe = async () => {
        let result: Awaited<ReturnType<typeof call>> | undefined
        // WindowServer and lazily enabled web AX providers publish separately.
        // Wait only on reads for this fixture's known ready control; inputs are
        // sent once and failed/uncertain writes are never replayed.
        await waitFor(async () => {
          const next = await call({
            action: "observe",
            pid,
            window_id: windowID,
            mode: "ax",
          })
          if (next.isError && next.structuredContent?.code === "stale_snapshot")
            return false
          assert(!next.isError, JSON.stringify(next.structuredContent))
          result = next
          if (multipleWindows) lastAction = next.structuredContent
          return (next.structuredContent?.elements as Row[]).some(
            (row) =>
              row.title === "Web increment" ||
              row.description === "Web increment",
          )
        })
        assert(result)
        return result
      }
      const target = (
        observation: Awaited<ReturnType<typeof observe>>,
        label: string,
      ) => {
        const elements = observation.structuredContent?.elements as Row[]
        const matches = elements.filter(
          (row) => row.title === label || row.description === label,
        )
        assert.equal(
          matches.length,
          1,
          `Expected unique ${label}: ${JSON.stringify(observation.structuredContent)}`,
        )
        const row = matches[0]
        assert(row)
        return row
      }
      const check = async (name: string, action: () => Promise<void>) => {
        if (values.case && !name.includes(values.case)) return
        const start = performance.now()
        lastAction = undefined
        try {
          await action()
          rows.push({
            engine,
            case: name,
            durationMs: performance.now() - start,
            status: "passed",
            evidence: lastAction,
          })
          console.log(`PASS ${engine}: ${name}`)
        } catch (error) {
          rows.push({
            engine,
            case: name,
            durationMs: performance.now() - start,
            status: "failed",
            state: await state(),
            secondaryState: multipleWindows
              ? await state(secondOutput)
              : undefined,
            evidence: lastAction,
          })
          throw error
        }
      }
      if (multipleWindows)
        await check(
          "two web windows keep addressed background input in the original window",
          async () => {
            const primaryWindow = windowID
            const listed = await call({ action: "list" })
            const secondWindow = (
              listed.structuredContent?.windows as {
                pid: number
                window_id: number
                title: string
              }[]
            ).find(
              (row) => row.pid === pid && row.title.endsWith(" 2"),
            )?.window_id
            assert(
              primaryWindow !== undefined &&
                secondWindow !== undefined &&
                primaryWindow !== secondWindow,
            )
            const readSecond = async () =>
              JSON.parse(await readFile(secondOutput, "utf8")) as State
            await waitFor(async () => {
              try {
                return (await readSecond()).ready
              } catch (cause) {
                if (
                  cause instanceof Error &&
                  "code" in cause &&
                  cause.code === "ENOENT"
                )
                  return false
                throw cause
              }
            })
            assert.equal((await state())?.first, "")
            assert.equal((await readSecond()).first, "")
            assert(backgroundPID !== undefined)
            try {
              const beforeKey = await observe()
              const refused = await call({
                action: "key",
                delivery: "background",
                snapshot_id: beforeKey.structuredContent?.snapshot_id,
                element: target(beforeKey, "Web first").element,
                key: "A",
              })
              lastAction = refused.structuredContent
              assert(
                refused.isError,
                "Non-key-window physical input must be refused",
              )
              assert.equal(refused.structuredContent?.code, "focus_unconfirmed")
              assert.equal((await state())?.first, "")
              assert.equal((await readSecond()).first, "")
              for (const [id, text] of [
                [primaryWindow, "Primary 猫"],
                [secondWindow, "Secondary 犬"],
                [primaryWindow, " again"],
              ] as const) {
                windowID = id
                const observed = await observe()
                const typed = await call({
                  action: "type",
                  delivery: "background",
                  snapshot_id: observed.structuredContent?.snapshot_id,
                  element: target(observed, "Web first").element,
                  text,
                })
                lastAction = typed.structuredContent
                assert(!typed.isError, JSON.stringify(typed.structuredContent))
                await waitFor(async () =>
                  id === primaryWindow
                    ? (await state())?.first ===
                      (text === " again" ? "Primary 猫 again" : text)
                    : (await readSecond()).first === text,
                )
                assert.equal(
                  (await call({ action: "status" })).structuredContent
                    ?.frontmost_pid,
                  backgroundPID,
                )
              }
              assert.equal((await state())?.first, "Primary 猫 again")
              assert.equal((await readSecond()).first, "Secondary 犬")
              assert.equal((await state())?.second, "")
              assert.equal((await readSecond()).second, "")
            } finally {
              windowID = primaryWindow
            }
          },
        )
      await check(
        "native screenshot captures the owned web page pixels",
        async () => {
          const captured = await call({
            action: "observe",
            pid,
            window_id: windowID,
            mode: "vision",
          })
          assert(!captured.isError, JSON.stringify(captured.structuredContent))
          const part = captured.content.find((part) => part.type === "image")
          assert(part?.type === "image")
          const { createCanvas, loadImage } = await import("@napi-rs/canvas")
          const image = await loadImage(Buffer.from(part.data, "base64"))
          assert.equal(image.width, captured.structuredContent?.image_width)
          assert.equal(image.height, captured.structuredContent?.image_height)
          const canvas = createCanvas(image.width, image.height),
            drawing = canvas.getContext("2d")
          drawing.drawImage(image, 0, 0)
          const pixels = drawing.getImageData(
            0,
            0,
            image.width,
            image.height,
          ).data
          let marker = 0
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const r = pixels[offset],
              g = pixels[offset + 1],
              b = pixels[offset + 2]
            if (
              r !== undefined &&
              g !== undefined &&
              b !== undefined &&
              Math.abs(r - 12) < 12 &&
              Math.abs(g - 34) < 12 &&
              Math.abs(b - 56) < 12
            )
              marker++
          }
          assert(
            marker > 100,
            `Missing the fixture's independent 20px color marker: ${marker} pixels`,
          )
        },
      )
      if (engine === "electron")
        await check(
          "provider activation survives turn cleanup while its web tree is pending",
          async () => {
            await waitFor(async () => {
              const observed = await call({
                action: "observe",
                pid,
                window_id: windowID,
                mode: "ax",
              })
              assert(
                !observed.isError,
                JSON.stringify(observed.structuredContent),
              )
              const rows = observed.structuredContent?.elements as Row[]
              const cleaned = await client.bindTool(cleanup)({})
              assert(!cleaned.isError)
              return rows.some(
                (row) =>
                  row.title === "Web increment" ||
                  row.description === "Web increment",
              )
            })
          },
        )
      await check(
        `${values.delivery} AX button and addressed BMP input`,
        async () => {
          const before = (await state())?.count
          assert(before !== undefined)
          let observed = await observe()
          const pressed = await call({
            action: "press",
            snapshot_id: observed.structuredContent?.snapshot_id,
            element: target(observed, "Web increment").element,
          })
          assert(!pressed.isError, JSON.stringify(pressed.structuredContent))
          await waitFor(async () => (await state())?.count === before + 1)
          for (const [label, key, text] of [
            ["Web first", "first", "Web 猫"],
            ["Web second", "second", "Second target"],
          ] as const) {
            observed = await observe()
            const typed = await call({
              action: "type",
              delivery: values.delivery,
              snapshot_id: observed.structuredContent?.snapshot_id,
              element: target(observed, label).element,
              text,
            })
            lastAction = typed.structuredContent
            assert(!typed.isError, JSON.stringify(typed.structuredContent))
            assert.equal(typed.structuredContent?.text_route, "unicode_events")
            await waitFor(async () => (await state())?.[key] === text)
            if (values.delivery === "background")
              assert.equal(
                (await call({ action: "status" })).structuredContent
                  ?.frontmost_pid,
                backgroundPID,
              )
          }
          assert.equal((await state())?.first, "Web 猫")
        },
      )
      await check(
        "a pinned preview connection preserves the agent's existing input ticket",
        async () => {
          const listed = await call({ action: "list" })
          const identity = (
            listed.structuredContent?.windows as {
              pid: number
              window_id: number
              launch_time: number
              frame: { x: number; y: number; width: number; height: number }
            }[]
          ).find((row) => row.pid === pid && row.window_id === windowID)
          assert(identity)
          const observed = await observe()
          const preview = new McpClient(
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
          try {
            const tools = await preview.start()
            const tool = tools.find((tool) => tool.name === "control")
            assert(tool)
            const capture = preview.bindTool(tool)
            const stale = await capture({
              action: "preview",
              mode: "vision",
              pid,
              window_id: windowID,
              launch_time: identity.launch_time + 1,
            })
            assert.equal(stale.structuredContent?.code, "stale_target")
            assert(!stale.content.some((part) => part.type === "image"))
            const fresh = await capture({
              action: "preview",
              mode: "vision",
              pid,
              window_id: windowID,
              launch_time: identity.launch_time,
            })
            assert(!fresh.isError, JSON.stringify(fresh.structuredContent))
            assert(fresh.content.some((part) => part.type === "image"))
            assert.equal(fresh.structuredContent?.snapshot_id, undefined)
            assert.equal(fresh.structuredContent?.input_available, false)
            assert.match(
              String(fresh.structuredContent?.preview_id),
              /^preview_/,
            )
            const refused = await capture({
              action: "click",
              snapshot_id: fresh.structuredContent?.preview_id,
              x: 10,
              y: 10,
            })
            assert.equal(refused.structuredContent?.code, "stale_snapshot")
            assert(
              (
                fresh.structuredContent?.windows as { launch_time: number }[]
              ).every((row) => row.launch_time === identity.launch_time),
            )
            const before = (await state())?.count
            assert(before !== undefined)
            const sameConnectionPreview = await call({
              action: "preview",
              pid,
              window_id: windowID,
              launch_time: identity.launch_time,
            })
            assert(
              !sameConnectionPreview.isError,
              JSON.stringify(sameConnectionPreview.structuredContent),
            )
            const pressed = await call({
              action: "press",
              snapshot_id: observed.structuredContent?.snapshot_id,
              element: target(observed, "Web increment").element,
            })
            assert(!pressed.isError, JSON.stringify(pressed.structuredContent))
            await waitFor(async () => (await state())?.count === before + 1)
            const move = (x: number, y: number) =>
              call({
                action: "window",
                window_action: "move",
                pid,
                window_id: windowID,
                launch_time: identity.launch_time,
                x,
                y,
              })
            try {
              for (let step = 0; step < 4; step++) {
                const [moved, frame]: [CallToolResult, CallToolResult] =
                  await Promise.all([
                    move(
                      identity.frame.x + (step % 2) * 8,
                      identity.frame.y + (step % 2) * 8,
                    ),
                    capture({
                      action: "preview",
                      pid,
                      window_id: windowID,
                      launch_time: identity.launch_time,
                    }),
                  ])
                assert(!moved.isError, JSON.stringify(moved.structuredContent))
                assert(!frame.isError, JSON.stringify(frame.structuredContent))
                assert.equal(frame.structuredContent?.input_available, false)
                assert.equal(
                  typeof frame.structuredContent?.geometry_stable,
                  "boolean",
                )
              }
            } finally {
              const restored = await move(identity.frame.x, identity.frame.y)
              assert(
                !restored.isError,
                JSON.stringify(restored.structuredContent),
              )
            }
          } finally {
            await preview.close()
          }
        },
      )
      await check(
        "background paste changes the page or reports unread content",
        async () => {
          const before = (await state())?.first
          const observed = await observe()
          const pasted = await call({
            action: "paste",
            snapshot_id: observed.structuredContent?.snapshot_id,
            element: target(observed, "Web first").element,
            text: "|",
          })
          lastAction = pasted.structuredContent
          if (pasted.isError) {
            assert.equal(
              pasted.structuredContent?.code,
              "paste_not_consumed",
              JSON.stringify(pasted.structuredContent),
            )
            assert.equal((await state())?.first, before)
          } else {
            await waitFor(async () => (await state())?.first === `${before}|`)
          }
          assert.equal(
            (await call({ action: "status" })).structuredContent?.frontmost_pid,
            backgroundPID,
          )
        },
      )
      await check(
        "background supplementary text is complete or explicitly unconfirmed",
        async () => {
          const before = (await state())?.first
          const observed = await observe()
          const typed = await call({
            action: "type",
            snapshot_id: observed.structuredContent?.snapshot_id,
            element: target(observed, "Web first").element,
            text: "😀",
          })
          lastAction = typed.structuredContent
          if (typed.isError) {
            assert(
              ["text_unconfirmed", "foreground_required"].includes(
                String(typed.structuredContent?.code),
              ),
              JSON.stringify(typed.structuredContent),
            )
            assert.equal((await state())?.first, before)
          } else {
            await waitFor(async () => (await state())?.first === `${before}😀`)
          }
          assert.equal(
            (await call({ action: "status" })).structuredContent?.frontmost_pid,
            backgroundPID,
          )
        },
      )
      await check(
        "background scroll changes the real web scroll container",
        async () => {
          const observed = await observe()
          const frame = target(observed, "Web scroll").frame
          assert(frame)
          const scrolled = await call({
            action: "scroll",
            snapshot_id: observed.structuredContent?.snapshot_id,
            coordinate_space: "screen",
            x: frame.x + frame.width / 2,
            y: frame.y + frame.height / 2,
            dy: -400,
          })
          assert(!scrolled.isError, JSON.stringify(scrolled.structuredContent))
          await waitFor(async () => ((await state())?.scrollTop ?? 0) > 0)
        },
      )
      await check(
        "isolation restores AX and WindowServer geometry without border drift",
        async () => {
          const before = await call({ action: "list" })
          type Window = {
            pid: number
            window_id: number
            launch_time: number
            frame: { x: number; y: number; width: number; height: number }
          }
          const originals = (
            before.structuredContent?.windows as Window[]
          ).filter((row) => row.pid === pid)
          const identity = originals.find((row) => row.window_id === windowID)
          assert(identity)
          const observed = await observe()
          const ax = (observed.structuredContent?.elements as Row[]).find(
            (row) => row.role === "AXWindow",
          )?.frame
          assert(ax)
          const concealed = await call({
            action: "isolation",
            isolation_action: "conceal",
            pid,
            launch_time: identity.launch_time,
          })
          assert(
            !concealed.isError,
            JSON.stringify(concealed.structuredContent),
          )
          try {
            await waitFor(async () => {
              const parked = await call({ action: "list" })
              const moved = (
                parked.structuredContent?.windows as Window[]
              ).find((row) => row.window_id === windowID)
              return (
                moved !== undefined &&
                !isDeepStrictEqual(moved.frame, identity.frame)
              )
            })
          } finally {
            const restored = await call({
              action: "isolation",
              isolation_action: "reveal",
              pid,
            })
            assert(
              !restored.isError,
              JSON.stringify(restored.structuredContent),
            )
          }
          await waitFor(async () => {
            const listed = await call({ action: "list" })
            const current = listed.structuredContent?.windows as Window[]
            return originals.every((original) =>
              isDeepStrictEqual(
                current.find((row) => row.window_id === original.window_id)
                  ?.frame,
                original.frame,
              ),
            )
          })
          const restored = await observe()
          assert.deepEqual(
            (restored.structuredContent?.elements as Row[]).find(
              (row) => row.role === "AXWindow",
            )?.frame,
            ax,
          )
        },
      )
      await check(
        "foreground drag delivers native HTML drag and drop",
        async () => {
          const observed = await observe()
          const from = target(observed, "Web drag source").frame,
            to = target(observed, "Web drop target").frame
          assert(from && to)
          const dragged = await call({
            action: "drag",
            delivery: "foreground",
            snapshot_id: observed.structuredContent?.snapshot_id,
            coordinate_space: "screen",
            x: from.x + from.width / 2,
            y: from.y + from.height / 2,
            to_x: to.x + to.width / 2,
            to_y: to.y + to.height / 2,
            duration: 0.5,
          })
          assert(!dragged.isError, JSON.stringify(dragged.structuredContent))
          await waitFor(async () => (await state())?.drops === 1)
          assert.equal((await state())?.dragStarts, 1)
        },
      )
      await check(
        "foreground paste delivers full Unicode without dropping emoji",
        async () => {
          const observed = await observe()
          const before = (await state())?.second
          const typed = await call({
            action: "type",
            delivery: "foreground",
            snapshot_id: observed.structuredContent?.snapshot_id,
            element: target(observed, "Web second").element,
            text: " 猫😀",
          })
          lastAction = typed.structuredContent
          assert(!typed.isError, JSON.stringify(typed.structuredContent))
          assert.equal(typed.structuredContent?.text_route, "clipboard")
          await waitFor(
            async () => (await state())?.second === `${before} 猫😀`,
          )
        },
      )
    } finally {
      await client.bindTool(cleanup)({})
      if (focusPID !== undefined) process.kill(focusPID, "SIGTERM")
      if (nativePID !== undefined) process.kill(nativePID, "SIGTERM")
      const running =
        child !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      const exited = running && child ? once(child, "exit") : undefined
      // Fixture startup errors can leave a native error dialog holding SIGTERM.
      // Bound only cleanup of this disposable child, not production shutdown.
      const force = running
        ? setTimeout(() => child?.kill("SIGKILL"), 2000)
        : undefined
      if (current?.pid !== undefined && running)
        process.kill(current.pid, "SIGTERM")
      else if (running) child?.kill("SIGTERM")
      try {
        await exited
      } finally {
        clearTimeout(force)
      }
    }
  }
  assert(rows.length > 0, "No cases matched")
} catch (error) {
  failure = error
} finally {
  await client.close()
  await rm(root, { recursive: true, force: true })
  const path = resolve(values.report)
  await mkdir(resolve(path, ".."), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify(
      {
        status: failure ? "failed" : "passed",
        rows,
        error: failure ? String(failure) : undefined,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Report: ${path}`)
}
if (failure) throw failure
