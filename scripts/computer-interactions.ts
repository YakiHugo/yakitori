import assert from "node:assert/strict"
import type { McpClient } from "../src/runtime/mcp-client.ts"

type Control = ReturnType<McpClient["bindTool"]>
type Result = Awaited<ReturnType<Control>>
type Element = {
  element: number
  title?: string
  description?: string
  actions?: string[]
}

export async function verifyComputerInteractions(context: {
  call: Control
  cleanup: () => Promise<unknown>
  pid: number
  windowID: number
  state: () => Promise<{
    count: number
    menu_count: number
    menus_open: number
    hover_alternate: boolean
    hover_moves: number
    hover_transitions: number
    pointer_down: number
    events: { type: number; window: number; x: number; y: number }[]
  }>
  waitFor: (predicate: () => Promise<boolean>) => Promise<void>
  check: (name: string, execute: () => Promise<void>) => Promise<void>
}) {
  const { call, pid, windowID, state, waitFor, check } = context
  const observe = async () => {
    let observed: Result | undefined
    await waitFor(async () => {
      const result = await call({
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
    return observed
  }
  const element = (result: Result, name: string) => {
    const found = (result.structuredContent?.elements as Element[]).find(
      (row) => row.title === name || row.description === name,
    )
    assert(
      found,
      `Missing native control ${name}: ${JSON.stringify(result.structuredContent)}`,
    )
    return found
  }
  const regular = async () => {
    process.kill(pid, "SIGWINCH")
    await waitFor(async () => {
      const listed = await call({ action: "list" })
      return (listed.structuredContent?.apps as { pid: number }[]).some(
        (app) => app.pid === pid,
      )
    })
  }
  const unchangedDesktop = async (before: Result) => {
    assert.notEqual(
      before.structuredContent?.frontmost_pid,
      pid,
      "Background acceptance requires another foreground app",
    )
    const after = await call({ action: "status" })
    assert.equal(
      after.structuredContent?.frontmost_pid,
      before.structuredContent?.frontmost_pid,
    )
    assert.deepEqual(
      after.structuredContent?.pointer,
      before.structuredContent?.pointer,
    )
  }

  await check(
    "menu path resolves nested native levels and consumes its input ticket",
    async () => {
      await regular()
      const observed = await observe()
      const before = (await state()).menu_count
      const desktop = await call({ action: "status" })
      const args = {
        action: "invoke_menu",
        snapshot_id: observed.structuredContent?.snapshot_id,
        path: ["Automation", "Actions", "Increment"],
      }
      const result = await call(args)
      assert(!result.isError, JSON.stringify(result.structuredContent))
      await waitFor(async () => (await state()).menu_count === before + 1)
      const replay = await call(args)
      assert.equal(replay.structuredContent?.code, "stale_snapshot")
      assert.equal((await state()).menu_count, before + 1)
      await unchangedDesktop(desktop)
    },
  )

  await check(
    "menu path refuses ambiguous disabled and missing native entries",
    async () => {
      await regular()
      const before = (await state()).menu_count
      for (const [label, code] of [
        ["Ambiguous", "menu_ambiguous"],
        ["Disabled", "menu_disabled"],
        ["Missing", "menu_not_found"],
      ]) {
        const observed = await observe()
        const result = await call({
          action: "invoke_menu",
          snapshot_id: observed.structuredContent?.snapshot_id,
          path: ["Automation", label],
        })
        assert.equal(
          result.structuredContent?.code,
          code,
          JSON.stringify(result.structuredContent),
        )
        assert.equal((await state()).menu_count, before)
        await waitFor(async () => (await state()).menus_open === 0)
      }
    },
  )

  await check(
    "cancelled menu expansion closes its native UI without invoking an item",
    async () => {
      await regular()
      const observed = await observe()
      const before = (await state()).menu_count
      const controller = new AbortController()
      const pending = call(
        {
          action: "invoke_menu",
          snapshot_id: observed.structuredContent?.snapshot_id,
          path: ["Automation", "Actions", "Not published"],
        },
        controller.signal,
      )
      const result = pending.then(
        () => "completed",
        () => "cancelled",
      )
      await new Promise((done) => setTimeout(done, 150))
      controller.abort()
      assert.equal(await result, "cancelled")
      // A subsequent read is also the native request's cancellation barrier.
      await observe()
      await waitFor(async () => (await state()).menus_open === 0)
      assert.equal((await state()).menu_count, before)
    },
  )

  await check(
    "background pointer move is delivered to the exact window without moving the real cursor",
    async () => {
      const observed = await observe()
      const before = await state()
      const desktop = await call({ action: "status" })
      const result = await call({
        action: "hover",
        snapshot_id: observed.structuredContent?.snapshot_id,
        coordinate_space: "normalized",
        x: 738,
        y: 428,
      })
      assert(!result.isError, JSON.stringify(result.structuredContent))
      await waitFor(async () =>
        (await state()).events.some(
          (event) =>
            event.type === 5 &&
            event.window === windowID &&
            Math.abs(event.x - 310) < 2 &&
            Math.abs(event.y - 190) < 2,
        ),
      )
      assert.equal((await state()).pointer_down, before.pointer_down)
      await unchangedDesktop(desktop)
    },
  )

  await check(
    "semantic hover preserves alternate UI across descendants and restores it on leave",
    async () => {
      let observed = await observe()
      const target = element(observed, "Alternate hover")
      assert(
        target.actions?.includes("AXShowAlternateUI"),
        JSON.stringify(target),
      )
      const revealed = await call({
        action: "hover",
        snapshot_id: observed.structuredContent?.snapshot_id,
        element: target.element,
      })
      assert(!revealed.isError, JSON.stringify(revealed.structuredContent))
      assert.equal(revealed.structuredContent?.hover_route, "accessibility")
      await waitFor(async () => (await state()).hover_alternate)
      const transitions = (await state()).hover_transitions
      observed = await observe()
      const child = await call({
        action: "hover",
        snapshot_id: observed.structuredContent?.snapshot_id,
        element: element(observed, "Hover child").element,
      })
      assert(!child.isError, JSON.stringify(child.structuredContent))
      assert.equal((await state()).hover_transitions, transitions)
      observed = await observe()
      const left = await call({
        action: "hover",
        snapshot_id: observed.structuredContent?.snapshot_id,
        element: element(observed, "Hover exit").element,
      })
      assert(!left.isError, JSON.stringify(left.structuredContent))
      await waitFor(async () => !(await state()).hover_alternate)
      assert.equal((await state()).hover_transitions, transitions + 1)
    },
  )

  await check(
    "turn cleanup restores a control's revealed alternate UI",
    async () => {
      const observed = await observe()
      const revealed = await call({
        action: "hover",
        snapshot_id: observed.structuredContent?.snapshot_id,
        element: element(observed, "Alternate hover").element,
      })
      assert(!revealed.isError, JSON.stringify(revealed.structuredContent))
      await waitFor(async () => (await state()).hover_alternate)
      await context.cleanup()
      await waitFor(async () => !(await state()).hover_alternate)
    },
  )
  await check(
    "foreground pixel hover reaches the native tracking area without clicking",
    async () => {
      await regular()
      const observed = await observe()
      const before = await state()
      const result = await call({
        action: "hover",
        delivery: "foreground",
        snapshot_id: observed.structuredContent?.snapshot_id,
        coordinate_space: "normalized",
        x: 738,
        y: 428,
      })
      assert(!result.isError, JSON.stringify(result.structuredContent))
      assert.equal(result.structuredContent?.hover_route, "pointer")
      await waitFor(
        async () => (await state()).hover_moves > before.hover_moves,
      )
      assert.equal((await state()).pointer_down, before.pointer_down)
    },
  )
}
