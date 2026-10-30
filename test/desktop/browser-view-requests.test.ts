import { EventEmitter } from "node:events"
import type { BrowserWindow } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import { BrowserViewRequests } from "../../src/desktop/browser-view-requests.ts"
import type { WorkspaceBrowserShowRequest } from "../../src/desktop/workspace-browser-types.ts"

const owner = { sessionId: "session_owned", turnId: "turn_owned" }
const owners: BrowserViewRequests[] = []
afterEach(() => {
  for (const ui of owners.splice(0)) ui.close()
  vi.useRealTimers()
})
function fixture() {
  const contents = new EventEmitter(),
    sent: WorkspaceBrowserShowRequest[] = []
  let current = true,
    destroyed = false
  const window = {
    isDestroyed: () => destroyed,
    get webContents() {
      if (destroyed) throw new Error("Window has been destroyed")
      return Object.assign(contents, {
        send: (_channel: string, request: WorkspaceBrowserShowRequest) =>
          sent.push(request),
      })
    },
  }
  const ui = new BrowserViewRequests(window as unknown as BrowserWindow)
  owners.push(ui)
  return {
    ui,
    contents,
    sent,
    destroy: () => {
      destroyed = true
      contents.emit("destroyed")
    },
    changeTarget: () => {
      current = false
    },
    start(signal = new AbortController().signal) {
      const pending = ui.show("owned", owner, () => current, signal)
      // Expected cancellation during test cleanup must not create an unhandled rejection.
      void pending.catch(() => {})
      const request = sent.at(-1)
      if (!request) throw new Error("Missing published show request")
      return { pending, id: request.requestId }
    },
  }
}

it("publishes owner-scoped display requests and accepts one claim before terminal acknowledgement", async () => {
  const f = fixture(),
    { pending, id } = f.start()
  expect(f.sent).toEqual([
    {
      requestId: expect.stringMatching(/^browser_show_[a-f0-9-]{36}$/),
      tabId: "owned",
      ownerSessionId: "session_owned",
    },
  ])
  expect(f.ui.claim(id)).toBe(true)
  expect(f.ui.claim(id)).toBe(false)
  await expect(
    f.ui.show("another", owner, () => true, new AbortController().signal),
  ).rejects.toMatchObject({ code: "browser_busy" })
  expect(f.sent).toHaveLength(1)
  expect(f.ui.complete(id, "applied")).toBe(true)
  await pending
  expect(f.ui.complete(id, "applied")).toBe(false)
  f.ui.assertIdle()
})

it("cancels unclaimed requests without allowing late renderer work", async () => {
  const f = fixture(),
    cancel = new AbortController(),
    { pending, id } = f.start(cancel.signal)
  cancel.abort()
  await expect(pending).rejects.toBe(cancel.signal.reason)
  expect(f.ui.claim(id)).toBe(false)
  expect(f.ui.complete(id, "applied")).toBe(false)
  f.ui.finishTurn(owner)
  f.ui.assertIdle()
})

it("waits for an already claimed request to acknowledge ordinary cancellation", async () => {
  const f = fixture(),
    cancel = new AbortController(),
    { pending, id } = f.start(cancel.signal)
  expect(f.ui.claim(id)).toBe(true)
  let completed = false
  void pending.then(() => {
    completed = true
  })
  cancel.abort()
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(() => f.ui.finishTurn(owner)).toThrow(/not acknowledged/)
  f.ui.complete(id, "applied")
  await pending
  f.ui.finishTurn(owner)
})

it("expires unclaimed requests before they can change the UI", async () => {
  vi.useFakeTimers()
  const f = fixture(),
    { pending, id } = f.start()
  await vi.advanceTimersByTimeAsync(5000)
  await expect(pending).rejects.toMatchObject({
    code: "browser_view_unavailable",
  })
  expect(f.ui.claim(id)).toBe(false)
  f.ui.assertIdle()
})

it("retains unknown claimed completion after its deadline and releases only on a late acknowledgement", async () => {
  vi.useFakeTimers()
  const f = fixture(),
    { pending, id } = f.start()
  f.ui.claim(id)
  await vi.advanceTimersByTimeAsync(5000)
  await expect(pending).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  expect(() => f.ui.assertIdle()).toThrow(/still owns/)
  expect(() => f.ui.finishTurn(owner)).toThrow(/not acknowledged/)
  expect(() => f.ui.closeSession(owner.sessionId)).toThrow(/not acknowledged/)
  f.ui.finishTurn({ ...owner, turnId: "other" })
  expect(f.ui.complete(id, "applied")).toBe(true)
  f.ui.finishTurn(owner)
  f.ui.assertIdle()
})

it.each([
  "render-process-gone",
  "did-navigate",
  "destroyed",
])("ends claimed requests when their original renderer context is lost (%s)", async (event) => {
  const f = fixture(),
    { pending, id } = f.start()
  f.ui.claim(id)
  f.contents.emit(event)
  await expect(pending).rejects.toMatchObject({ code: "browser_unavailable" })
  expect(f.ui.complete(id, "applied")).toBe(false)
  f.ui.finishTurn(owner)
  f.ui.assertIdle()
})

it("refuses a target that changed before claim and accepts refusal without UI mutation", async () => {
  const f = fixture(),
    first = f.start()
  f.changeTarget()
  expect(f.ui.claim(first.id)).toBe(false)
  await expect(first.pending).rejects.toMatchObject({
    code: "browser_target_changed",
  })
  f.ui.assertIdle()
  const other = fixture(),
    second = other.start()
  other.ui.complete(second.id, "refused")
  await expect(second.pending).rejects.toMatchObject({
    code: "browser_view_unavailable",
  })
  other.ui.assertIdle()
})

it("requires a claim for applied receipts and treats a renderer's failed terminal receipt as completed work", async () => {
  const f = fixture(),
    { pending, id } = f.start()
  expect(() => f.ui.complete(id, "applied")).toThrow(/must be claimed/)
  f.ui.claim(id)
  f.ui.complete(id, "failed")
  await expect(pending).rejects.toMatchObject({
    code: "browser_input_unconfirmed",
  })
  f.ui.assertIdle()
})

it("session cleanup cancels only its unclaimed request and removes its renderer listeners on close", async () => {
  const f = fixture(),
    { pending, id } = f.start()
  f.ui.closeSession("other")
  expect(f.ui.claim("unknown")).toBe(false)
  f.ui.closeSession(owner.sessionId)
  await expect(pending).rejects.toMatchObject({ code: "browser_cancelled" })
  expect(f.ui.claim(id)).toBe(false)
  f.ui.close()
  for (const event of ["render-process-gone", "did-navigate", "destroyed"])
    expect(f.contents.listenerCount(event)).toBe(0)
})

it("removes listeners after the original window and its webContents accessor are destroyed", async () => {
  const f = fixture(),
    { pending } = f.start()
  f.destroy()
  await expect(pending).rejects.toMatchObject({ code: "browser_unavailable" })
  expect(() => f.ui.close()).not.toThrow()
  expect(f.contents.listenerCount("destroyed")).toBe(0)
})
