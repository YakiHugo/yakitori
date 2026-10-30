import assert from "node:assert/strict"
import type { McpClient } from "../src/runtime/mcp-client.ts"

type Control = ReturnType<McpClient["bindTool"]>
type Result = Awaited<ReturnType<Control>>
type FixtureState = {
  count: number
  rich: string
  rich_bold: boolean
  changes: number
  hidden: boolean
  secondary_minimized: boolean
  pointer_down: number
  pointer_up: number
  rich_selection: { location: number; length: number }
  events: { type: number; flags: number }[]
  secondary_frame: { x: number; y: number; width: number; height: number }
}

export async function verifyComputerCapabilities(context: {
  call: Control
  cleanup: () => Promise<unknown>
  pid: number
  windowID: number
  state: () => Promise<FixtureState>
  waitFor: (predicate: () => Promise<boolean>) => Promise<void>
  check: (name: string, execute: () => Promise<void>) => Promise<void>
}) {
  const { call, pid, windowID, state, waitFor, check } = context
  const regularFixture = async () => {
    process.kill(pid, "SIGWINCH")
    await waitFor(async () => {
      const listed = await call({ action: "list" })
      return (listed.structuredContent?.apps as { pid: number }[]).some(
        (app) => app.pid === pid,
      )
    })
  }
  const observe = async () => {
    let result: Result | undefined
    await waitFor(async () => {
      const next = await call({ action: "observe", pid, window_id: windowID })
      if (
        next.isError &&
        ["stale_snapshot", "window_not_found"].includes(
          String(next.structuredContent?.code),
        )
      )
        return false
      assert(!next.isError, JSON.stringify(next.structuredContent))
      result = next
      return true
    })
    assert(result)
    return result
  }
  const element = (observed: Result, name: string) => {
    const row = (
      observed.structuredContent?.elements as {
        element: number
        title?: string
        description?: string
      }[]
    ).find((entry) => entry.title === name || entry.description === name)
    assert(row, `Missing control: ${name}`)
    return row.element
  }
  const input = async (
    action: string,
    observed: Result,
    args: Record<string, unknown>,
  ) => {
    const result = await call({
      action,
      snapshot_id: observed.structuredContent?.snapshot_id,
      ...args,
    })
    assert(!result.isError, JSON.stringify(result.structuredContent))
    return result
  }
  const setText = async (text: string) => {
    const observed = await observe()
    await input("set_value", observed, {
      element: element(observed, "Rich input"),
      value: text,
    })
    await waitFor(async () => (await state()).rich === text)
  }
  await check(
    "cached AX pages and subtrees never renew consumed input",
    async () => {
      const observed = await observe()
      const id = observed.structuredContent?.snapshot_id
      const page = await call({ action: "query", snapshot_id: id, limit: 1 })
      assert(!page.isError)
      assert.equal((page.structuredContent?.elements as unknown[]).length, 1)
      assert.equal(page.structuredContent?.next_offset, 1)
      const found = await call({
        action: "query",
        snapshot_id: id,
        query: "rich input",
      })
      assert.equal(found.structuredContent?.total_matches, 1)
      const before = (await state()).count
      await input("perform_action", observed, {
        element: element(observed, "Secondary increment"),
        action_name: "AXPress",
      })
      await waitFor(async () => (await state()).count === before + 1)
      const consumed = await call({ action: "query", snapshot_id: id })
      assert.equal(consumed.structuredContent?.input_available, false)
      const again = await call({
        action: "press",
        snapshot_id: id,
        element: element(observed, "Secondary increment"),
      })
      assert.equal(again.structuredContent?.code, "stale_snapshot")
      assert.equal((await state()).count, before + 1)
      const fresh = await observe()
      const subtree = await call({
        action: "observe",
        pid,
        window_id: windowID,
        mode: "ax",
        snapshot_id: fresh.structuredContent?.snapshot_id,
        root_element: element(fresh, "Rich input"),
      })
      assert(!subtree.isError, JSON.stringify(subtree.structuredContent))
      assert.notEqual(subtree.structuredContent?.snapshot_id, id)
      assert.equal(
        (subtree.structuredContent?.elements as { role: string }[])[0]?.role,
        "AXTextArea",
      )
    },
  )
  await check(
    "AX selection disambiguates UTF-16 text and changes the real field",
    async () => {
      await setText("a😀猫猫b")
      let observed = await observe()
      const selection = await input("select_text", observed, {
        element: element(observed, "Rich input"),
        text: "猫",
        suffix: "b",
      })
      assert.deepEqual(selection.structuredContent?.selection, {
        location: 4,
        length: 1,
      })
      observed = await observe()
      await input("type", observed, {
        element: element(observed, "Rich input"),
        text: "X",
        delivery: "foreground",
      })
      await waitFor(async () => (await state()).rich === "a😀猫Xb")
      await setText("repeat repeat")
      observed = await observe()
      const refused = await call({
        action: "select_text",
        snapshot_id: observed.structuredContent?.snapshot_id,
        element: element(observed, "Rich input"),
        text: "repeat",
      })
      assert.equal(refused.structuredContent?.code, "ambiguous_text")
      assert.equal((await state()).rich, "repeat repeat")
    },
  )
  await check(
    "paste delivers text, Markdown RTF, and HTML to a rich editor",
    async () => {
      for (const args of [
        { text: "Plain", format: "text", expected: "Plain", bold: false },
        {
          text: "**Markdown**",
          format: "markdown",
          expected: "Markdown",
          bold: true,
        },
        {
          text: "<html><body><b>HTML</b></body></html>",
          plain_text: "HTML",
          format: "html",
          expected: "HTML",
          bold: true,
        },
      ]) {
        await setText("")
        const observed = await observe()
        await input("paste", observed, {
          element: element(observed, "Rich input"),
          text: args.text,
          format: args.format,
          ...("plain_text" in args ? { plain_text: args.plain_text } : {}),
          delivery: "foreground",
        })
        await waitFor(async () => (await state()).rich.trim() === args.expected)
        assert.equal((await state()).rich_bold, args.bold)
      }
    },
  )
  await check(
    "postcondition and after observe delayed state without replaying AX input",
    async () => {
      const observed = await observe()
      const before = (await state()).changes
      const result = await input("perform_action", observed, {
        element: element(observed, "Change later"),
        action_name: "AXPress",
        expect: { role: "AXTextArea", value: `Later-${before + 1}` },
        timeout: 2,
        after: "both",
      })
      assert.equal(
        result.structuredContent?.verification,
        "matched",
        JSON.stringify(result.structuredContent),
      )
      assert.equal((await state()).changes, before + 1)
      assert(result.content.some((part) => part.type === "image"))
      const observation = result.structuredContent?.observation as {
        snapshot_id: string
      }
      assert.notEqual(
        observation.snapshot_id,
        observed.structuredContent?.snapshot_id,
      )
    },
  )
  await check(
    "application menu actions retain their application identity",
    async () => {
      await regularFixture()
      const observed = await call({
        action: "observe",
        scope: "app",
        mode: "ax",
        pid,
      })
      assert(!observed.isError, JSON.stringify(observed.structuredContent))
      const rows = observed.structuredContent?.elements as {
        element: number
        title?: string
        anchor_window_id?: number
      }[]
      const menu = rows.find((row) => row.title === "Delayed menu update")
      assert(menu, JSON.stringify(rows))
      assert(
        (observed.structuredContent?.windows as { window_id: number }[]).some(
          (item) => item.window_id === menu.anchor_window_id,
        ),
      )
      const before = (await state()).changes
      await input("perform_action", observed, {
        element: menu.element,
        action_name: "AXPress",
        expect: { role: "AXTextArea", value: `Later-${before + 1}` },
        timeout: 2,
      })
      await waitFor(async () => (await state()).changes === before + 1)
    },
  )
  await check(
    "normal condition timeout is evidence rather than a delivery error",
    async () => {
      const result = await call({
        action: "wait_for",
        pid,
        window_id: windowID,
        expect: { value: "unreachable-owned-fixture-value" },
        timeout: 0.15,
      })
      assert(!result.isError, JSON.stringify(result.structuredContent))
      assert.equal(result.structuredContent?.matched, false)
      assert.equal(result.structuredContent?.timed_out, true)
    },
  )
  await check(
    "wait_for_change observes an external AppKit update",
    async () => {
      const waiting = call({
        action: "wait_for_change",
        pid,
        window_id: windowID,
        timeout: 2,
      })
      const outcome = waiting.then((value) => value)
      await new Promise((done) => setTimeout(done, 200))
      process.kill(pid, "SIGHUP")
      const result = await outcome
      assert(!result.isError, JSON.stringify(result.structuredContent))
      assert.equal(result.structuredContent?.changed, true)
      assert.equal(result.structuredContent?.timed_out, false)
    },
  )
  await check(
    "ordered key chords move the actual editor selection",
    async () => {
      await setText("ab")
      let observed = await observe()
      await input("select_text", observed, {
        element: element(observed, "Rich input"),
        text: "ab",
        selection_type: "cursor_before",
      })
      observed = await observe()
      await input("keys", observed, {
        element: element(observed, "Rich input"),
        keys: ["RIGHT", "RIGHT"],
        delivery: "foreground",
      })
      await waitFor(async () => (await state()).rich_selection.location === 2)
    },
  )
  await check(
    "native batches prevalidate all steps and preserve partial delivery evidence",
    async () => {
      const listed = await call({ action: "list" })
      const window = (
        listed.structuredContent?.windows as {
          window_id: number
          launch_time: number
        }[]
      ).find((item) => item.window_id === windowID)
      assert(window)
      const target = {
        action: "sequence",
        pid,
        window_id: windowID,
        launch_time: window.launch_time,
      }
      const press = {
        action: "press",
        selector: { title: "Secondary increment" },
      }
      const before = (await state()).count
      const invalid = await call({
        ...target,
        steps: [
          press,
          {
            action: "keys",
            selector: { description: "Rich input" },
            keys: ["TYPO"],
          },
        ],
      })
      assert.equal(invalid.structuredContent?.code, "invalid_arguments")
      assert.equal((await state()).count, before)
      const selector = { role: "AXTextArea", description: "Rich input" }
      const completed = await call({
        ...target,
        steps: [
          { action: "set_value", selector, value: "abc" },
          { action: "select_text", selector, text: "b" },
          { action: "type", selector, text: "X", delivery: "foreground" },
        ],
        after: "ax",
      })
      assert(!completed.isError, JSON.stringify(completed.structuredContent))
      assert.equal(
        (completed.structuredContent?.completed_steps as unknown[]).length,
        3,
      )
      await waitFor(async () => (await state()).rich === "aXc")
      const stopped = await call({
        ...target,
        steps: [
          press,
          { action: "press", selector: { title: "Missing owned control" } },
          press,
        ],
      })
      assert.equal(stopped.isError, true)
      assert.equal(stopped.structuredContent?.code, "ambiguous_element")
      assert.equal(
        (stopped.structuredContent?.completed_steps as unknown[]).length,
        1,
      )
      assert.equal(stopped.structuredContent?.stopped_at, 1)
      await waitFor(async () => (await state()).count === before + 1)
    },
  )
  await check(
    "cancelled long modified click releases both pointer and modifier",
    async () => {
      const observed = await observe()
      const before = await state()
      const controller = new AbortController()
      const clicking = call(
        {
          action: "click",
          snapshot_id: observed.structuredContent?.snapshot_id,
          x: 110,
          y: 114,
          duration: 3,
          modifiers: ["shift"],
          delivery: "foreground",
        },
        controller.signal,
      )
      const outcome = clicking.then(
        () => "completed",
        () => "cancelled",
      )
      await waitFor(
        async () => (await state()).pointer_down === before.pointer_down + 1,
      )
      assert.equal((await state()).pointer_up, before.pointer_up)
      controller.abort()
      assert.equal(await outcome, "cancelled")
      await context.cleanup()
      await waitFor(
        async () => (await state()).pointer_up === before.pointer_up + 1,
      )
      assert(
        (await state()).events.some(
          (event) => event.type === 1 && (event.flags & (1 << 17)) !== 0,
        ),
      )
      const next = await observe()
      const count = (await state()).count
      await input("press", next, {
        element: element(next, "Secondary increment"),
      })
      await waitFor(async () => (await state()).count === count + 1)
    },
  )
  await check(
    "window management validates process identity and restores minimized geometry",
    async () => {
      await regularFixture()
      const listed = await call({ action: "list" })
      const target = (
        listed.structuredContent?.windows as {
          pid: number
          window_id: number
          launch_time: number
        }[]
      ).find((window) => window.pid === pid && window.window_id === windowID)
      assert(target)
      const manage = async (
        window_action: string,
        extra: Record<string, unknown> = {},
      ) => {
        const result = await call({
          action: "window",
          pid,
          window_id: windowID,
          launch_time: target.launch_time,
          window_action,
          ...extra,
        })
        assert(!result.isError, JSON.stringify(result.structuredContent))
      }
      const invalid = await call({
        action: "window",
        pid,
        window_id: windowID,
        launch_time: 1,
        window_action: "move",
        x: 300,
        y: 200,
      })
      assert.equal(invalid.structuredContent?.code, "invalid_arguments")
      await manage("move", { x: 300, y: 200 })
      await waitFor(
        async () => (await observe()).structuredContent?.frame !== undefined,
      )
      await manage("resize", { width: 240, height: 210 })
      await waitFor(
        async () =>
          (await state()).secondary_frame.width === 240 &&
          (await state()).secondary_frame.height === 210,
      )
      await manage("minimize")
      await waitFor(async () => (await state()).secondary_minimized)
      const hidden = await call({ action: "list", include_hidden: true })
      assert(
        (hidden.structuredContent?.windows as { window_id: number }[]).some(
          (window) => window.window_id === windowID,
        ),
      )
      await manage("restore")
      await waitFor(async () => !(await state()).secondary_minimized)
      await manage("hide")
      await waitFor(async () => (await state()).hidden)
      await manage("show")
      await waitFor(async () => !(await state()).hidden)
    },
  )
}
