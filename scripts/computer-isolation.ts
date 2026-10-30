import assert from "node:assert/strict"
import { McpClient } from "../src/runtime/mcp-client.ts"

type Control = ReturnType<McpClient["bindTool"]>
type Frame = { x: number; y: number; width: number; height: number }

export async function verifyComputerIsolation(context: {
  call: Control
  cleanup: () => Promise<unknown>
  executable: string
  pid: number
  windowID: number
  state: () => Promise<{
    count: number
    window_id: number
    secondary_frame: Frame
    window_server: {
      id: number
      frame: { X: number; Y: number }
      onscreen: boolean
    }[]
    window_spaces: {
      id: number
      visible: boolean
      active_space: boolean
      spaces: number[]
    }[]
  }>
  waitFor: (
    predicate: () => Promise<boolean>,
    timeoutMs?: number,
  ) => Promise<void>
  check: (name: string, execute: () => Promise<void>) => Promise<void>
}) {
  const { call, pid, windowID, state, waitFor, check } = context
  const originalFrame = (await state()).secondary_frame
  const originalMembership = (await state()).window_spaces.filter(
    (window) => window.visible && window.active_space,
  )
  assert(originalMembership.some((window) => window.id === windowID))
  const originalWindows = (await state()).window_server.filter((window) =>
    originalMembership.some((member) => member.id === window.id),
  )
  assert.equal(originalWindows.length, originalMembership.length)
  const createOwner = async () => {
    const client = new McpClient(
      "computer",
      { command: context.executable, args: ["--mcp"] },
      () => {},
      () => {},
      () => {},
    )
    const tools = await client.start()
    const control = tools.find((tool) => tool.name === "control")
    assert(control)
    const invoke = client.bindTool(control)
    const status = await invoke({ action: "status" })
    return {
      client,
      call: invoke,
      pid: status.structuredContent?.process_id as number,
    }
  }
  const observeReady = async (invoke: Control) => {
    let observed: Awaited<ReturnType<Control>> | undefined
    await waitFor(async () => {
      const result = await invoke({
        action: "observe",
        pid,
        window_id: windowID,
        mode: "ax",
      })
      if (
        result.isError &&
        ["stale_snapshot", "window_not_found"].includes(
          String(result.structuredContent?.code),
        )
      )
        return false
      assert(!result.isError, JSON.stringify(result.structuredContent))
      if (
        !(result.structuredContent?.elements as { title?: string }[]).some(
          (row) => row.title === "Secondary increment",
        )
      )
        return false
      observed = result
      return true
    })
    assert(observed)
    return observed
  }
  const conceal = async (invoke: Control) => {
    const listed = await invoke({ action: "list" })
    const window = (
      listed.structuredContent?.windows as {
        pid: number
        window_id: number
        launch_time: number
      }[]
    ).find((window) => window.pid === pid && window.window_id === windowID)
    assert(window)
    const result = await invoke({
      action: "isolation",
      isolation_action: "conceal",
      pid,
      launch_time: window.launch_time,
    })
    assert(!result.isError, JSON.stringify(result.structuredContent))
    assert.equal(result.structuredContent?.effect, "concealed")
    return result.structuredContent as {
      display_id: number
      service_pid: number
    }
  }
  const waitRestored = async (frame: Frame) =>
    waitFor(async () => {
      const current = await state()
      const actual = current.secondary_frame
      return (
        Math.abs(actual.x - frame.x) < 2 &&
        Math.abs(actual.y - frame.y) < 2 &&
        originalWindows.every((before) =>
          current.window_server.some(
            (after) =>
              after.id === before.id &&
              after.onscreen &&
              Math.abs(after.frame.X - before.frame.X) < 2 &&
              Math.abs(after.frame.Y - before.frame.Y) < 2,
          ),
        ) &&
        originalMembership.every((before) =>
          current.window_spaces.some(
            (after) =>
              after.id === before.id &&
              after.visible &&
              after.active_space &&
              before.spaces.length === after.spaces.length &&
              before.spaces.every((space) => after.spaces.includes(space)),
          ),
        )
      )
    })
  await check(
    "another helper's input invalidates an older observation",
    async () => {
      const owner = await createOwner()
      try {
        const first = await observeReady(call)
        const second = await observeReady(owner.call)
        const find = (result: Awaited<ReturnType<Control>>) => {
          const row = (
            result.structuredContent?.elements as {
              element: number
              title?: string
            }[]
          ).find((row) => row.title === "Secondary increment")
          assert(row)
          return row.element
        }
        const before = (await state()).count
        const effect = await owner.call({
          action: "press",
          snapshot_id: second.structuredContent?.snapshot_id,
          element: find(second),
        })
        assert(!effect.isError, JSON.stringify(effect.structuredContent))
        await waitFor(async () => (await state()).count === before + 1)
        const stale = await call({
          action: "press",
          snapshot_id: first.structuredContent?.snapshot_id,
          element: find(first),
        })
        assert.equal(stale.structuredContent?.code, "stale_snapshot")
        assert.equal((await state()).count, before + 1)
      } finally {
        await owner.client.close()
      }
    },
  )
  await check(
    "isolated display preserves real layout, background input, and turn restoration",
    async () => {
      const original = (await state()).secondary_frame
      const before = await call({ action: "list" })
      const physical = before.structuredContent?.displays as {
        display_id: number
        frame: Frame
      }[]
      const isolated = await conceal(call)
      try {
        const after = await call({ action: "list" })
        const displays = after.structuredContent?.displays as {
          display_id: number
          frame: Frame
        }[]
        for (const display of physical)
          assert.deepEqual(
            displays.find((item) => item.display_id === display.display_id)
              ?.frame,
            display.frame,
          )
        assert(
          displays.some(
            (display) => display.display_id === isolated.display_id,
          ),
        )
        let observed: Awaited<ReturnType<Control>> | undefined
        await waitFor(async () => {
          const next = await call({
            action: "observe",
            pid,
            window_id: windowID,
          })
          if (next.isError && next.structuredContent?.code === "stale_snapshot")
            return false
          assert(!next.isError, JSON.stringify(next.structuredContent))
          observed = next
          return true
        })
        assert(observed)
        assert(observed.content.some((part) => part.type === "image"))
        const status = await call({ action: "status" })
        const count = (await state()).count
        const height = (observed.structuredContent?.frame as Frame).height
        const refused = await call({
          action: "click",
          snapshot_id: observed.structuredContent?.snapshot_id,
          x: 110,
          y: height - 78,
          delivery: "foreground",
        })
        assert.equal(refused.structuredContent?.code, "app_concealed")
        const clicked = await call({
          action: "click",
          snapshot_id: observed.structuredContent?.snapshot_id,
          x: 110,
          y: height - 78,
        })
        assert(!clicked.isError, JSON.stringify(clicked.structuredContent))
        await waitFor(async () => (await state()).count === count + 1)
        const final = await call({ action: "status" })
        assert.deepEqual(
          final.structuredContent?.pointer,
          status.structuredContent?.pointer,
        )
        assert.equal(
          final.structuredContent?.frontmost_pid,
          status.structuredContent?.frontmost_pid,
        )
      } finally {
        await context.cleanup()
      }
      await waitRestored(original)
    },
  )
  await check(
    "connection EOF restores its isolated windows before helper exit",
    async () => {
      const original = (await state()).secondary_frame
      const owner = await createOwner()
      try {
        await conceal(owner.call)
      } finally {
        await owner.client.close()
      }
      await waitRestored(original)
    },
  )
  await check(
    "recovery service restores isolated windows after helper SIGKILL",
    async () => {
      const original = (await state()).secondary_frame
      const owner = await createOwner()
      try {
        await conceal(owner.call)
        process.kill(owner.pid, "SIGKILL")
        await waitRestored(original)
      } finally {
        await owner.client.close()
      }
    },
  )
  await check(
    "isolation ownership blocks another helper's cancelled input",
    async () => {
      const original = (await state()).secondary_frame
      const owner = await createOwner()
      const competitor = await createOwner()
      try {
        await conceal(owner.call)
        let observed: Awaited<ReturnType<Control>> | undefined
        await waitFor(async () => {
          const result = await competitor.call({
            action: "observe",
            pid,
            window_id: windowID,
            mode: "ax",
          })
          if (
            result.isError &&
            ["stale_snapshot", "window_not_found"].includes(
              String(result.structuredContent?.code),
            )
          )
            return false
          assert(!result.isError, JSON.stringify(result.structuredContent))
          observed = result
          return true
        })
        assert(observed)
        const button = (
          observed.structuredContent?.elements as {
            element: number
            title?: string
          }[]
        ).find((row) => row.title === "Secondary increment")
        assert(button)
        const count = (await state()).count
        const controller = new AbortController()
        const outcome = competitor
          .call(
            {
              action: "press",
              snapshot_id: observed.structuredContent?.snapshot_id,
              element: button.element,
            },
            controller.signal,
          )
          .then(
            () => "completed",
            () => "cancelled",
          )
        await new Promise((done) => setTimeout(done, 150))
        controller.abort()
        assert.equal(await outcome, "cancelled")
        await competitor.client.close()
        assert.equal((await state()).count, count)
        const revealed = await owner.call({
          action: "isolation",
          isolation_action: "reveal",
        })
        assert(!revealed.isError, JSON.stringify(revealed.structuredContent))
        assert.equal(revealed.structuredContent?.remaining_windows, 0)
      } finally {
        await competitor.client.close()
        await owner.client.close()
      }
      await waitRestored(original)
    },
  )
  await check(
    "display service death returns owned windows to a physical display",
    async () => {
      // Previous cases finish an asynchronous AX restore. Establish this
      // case's own visible-window precondition before recording its baseline.
      await waitFor(async () => {
        const observed = await call({
          action: "observe",
          pid,
          window_id: windowID,
          mode: "ax",
        })
        if (
          observed.isError &&
          ["stale_snapshot", "window_not_found"].includes(
            String(observed.structuredContent?.code),
          )
        )
          return false
        assert(!observed.isError, JSON.stringify(observed.structuredContent))
        return (await state()).window_spaces.some(
          (window) =>
            window.id === windowID && window.visible && window.active_space,
        )
      })
      const originalMembership = (await state()).window_spaces.filter(
        (window) => window.visible && window.active_space,
      )
      assert(originalMembership.some((window) => window.id === windowID))
      const existing = await call({
        action: "isolation",
        isolation_action: "status",
      })
      const before = await call({ action: "list" })
      const original = (
        before.structuredContent?.windows as {
          window_id: number
          frame: Frame
          launch_time: number
        }[]
      ).find((window) => window.window_id === windowID)
      assert(original)
      const physical = (
        before.structuredContent?.displays as {
          display_id: number
          frame: Frame
        }[]
      ).filter(
        (display) =>
          display.display_id !== existing.structuredContent?.display_id,
      )
      assert(physical.length > 0)
      const owner = await createOwner()
      try {
        const desktopBefore = await call({ action: "status" })
        const isolated = await conceal(owner.call)
        process.kill(isolated.service_pid, "SIGKILL")
        let lastListed: unknown
        try {
          await waitFor(async () => {
            const listed = await call({ action: "list", include_hidden: true })
            lastListed = listed.structuredContent
            const target = (
              listed.structuredContent?.windows as {
                window_id: number
                frame: Frame
              }[]
            ).find((window) => window.window_id === windowID)
            return (
              target !== undefined &&
              physical.some(
                (display) =>
                  target.frame.x >= display.frame.x &&
                  target.frame.x < display.frame.x + display.frame.width &&
                  target.frame.y >= display.frame.y &&
                  target.frame.y < display.frame.y + display.frame.height,
              )
            )
          })
        } catch (error) {
          throw new Error(
            `${String(error)}; physical=${JSON.stringify(physical)}; listed=${JSON.stringify(lastListed)}`,
          )
        }
        const revealed = await owner.call({
          action: "isolation",
          isolation_action: "reveal",
        })
        assert(!revealed.isError, JSON.stringify(revealed.structuredContent))
        assert.equal(revealed.structuredContent?.remaining_windows, 0)
        await waitFor(async () => {
          const actual = (await state()).window_spaces
          return originalMembership.every((before) =>
            actual.some(
              (after) =>
                after.id === before.id &&
                after.visible &&
                after.active_space &&
                before.spaces.length === after.spaces.length &&
                before.spaces.every((space) => after.spaces.includes(space)),
            ),
          )
        })
        await waitFor(async () => {
          const visible = await owner.call({
            action: "observe",
            pid,
            window_id: windowID,
            mode: "both",
          })
          if (
            visible.isError &&
            ["stale_snapshot", "window_not_found"].includes(
              String(visible.structuredContent?.code),
            )
          )
            return false
          assert(!visible.isError, JSON.stringify(visible.structuredContent))
          return visible.content.some((part) => part.type === "image")
        })
        const desktopAfter = await call({ action: "status" })
        assert.equal(
          desktopAfter.structuredContent?.frontmost_pid,
          desktopBefore.structuredContent?.frontmost_pid,
        )
        assert.deepEqual(
          desktopAfter.structuredContent?.pointer,
          desktopBefore.structuredContent?.pointer,
        )
      } finally {
        await owner.client.close()
      }
    },
  )
  const retiring = await call({
    action: "isolation",
    isolation_action: "status",
  })
  const released = await call({
    action: "isolation",
    isolation_action: "reveal",
  })
  assert(!released.isError, JSON.stringify(released.structuredContent))
  await waitFor(async () => {
    const status = await call({
      action: "isolation",
      isolation_action: "status",
    })
    if (status.structuredContent?.display_id !== null) return false
    const servicePID = retiring.structuredContent?.service_pid
    if (typeof servicePID !== "number") return true
    try {
      process.kill(servicePID, 0)
      return false
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return true
      throw error
    }
  }, 10_000)
  await waitRestored(originalFrame)
}
