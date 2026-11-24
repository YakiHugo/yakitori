import { expect, it } from "vitest"
import {
  BrowserControlError,
  type BrowserTarget,
} from "../../src/protocol/desktop-browser.ts"
import { BrowserControl } from "../../src/server/browser-control.ts"

const first = { sessionId: "session_first", turnId: "turn_first" }
const second = { sessionId: "session_second", turnId: "turn_second" }
const tab: BrowserTarget = {
  tabId: "tab_first",
  webContentsId: 1,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const other = { ...tab, tabId: "tab_second", webContentsId: 2 }

it("dispatches operations on another tab while an owned tab is still settling", async () => {
  const load = Promise.withResolvers<void>()
  const control = new BrowserControl({
    async request(input) {
      if (input.action === "navigate") await load.promise
      return { loaded: true }
    },
    async finishTurn() {},
    async closeSession() {},
  })
  control.track(first, async () => {})
  control.track(second, async () => {})
  const pending = control.request(
    {
      action: "navigate",
      target: tab,
      fromUrl: "",
      url: "https://fixture.test/",
    },
    first,
  )
  await expect(
    control.request({ action: "observe", target: tab }, second),
  ).rejects.toMatchObject({ code: "browser_busy" })
  await expect(
    control.request({ action: "observe", target: other }, second),
  ).resolves.toEqual({ loaded: true })
  load.resolve()
  await pending
  await control.finishTurn(first)
  await expect(
    control.request({ action: "observe", target: tab }, second),
  ).resolves.toEqual({ loaded: true })
  await control.finishTurn(second)
})

it("keeps a timed-out mutation quarantined until the owning tab cleanup is confirmed", async () => {
  const cleanup = Promise.withResolvers<void>()
  const control = new BrowserControl({
    async request(input) {
      if (input.action === "navigate")
        throw new BrowserControlError("browser_timeout", "Unconfirmed load")
      return { ok: true }
    },
    async finishTurn(owner) {
      if (owner.sessionId === first.sessionId) await cleanup.promise
    },
    async closeSession() {},
  })
  control.track(first, async () => {})
  control.track(second, async () => {})
  await expect(
    control.request(
      {
        action: "navigate",
        target: tab,
        fromUrl: "",
        url: "https://fixture.test/",
      },
      first,
    ),
  ).rejects.toMatchObject({ code: "browser_timeout" })
  const finishing = control.finishTurn(first)
  await expect(
    control.request({ action: "observe", target: tab }, second),
  ).rejects.toMatchObject({ code: "browser_cleanup_pending" })
  await expect(
    control.request({ action: "observe", target: other }, second),
  ).resolves.toEqual({ ok: true })
  cleanup.resolve()
  await finishing
  await expect(
    control.request({ action: "observe", target: tab }, second),
  ).resolves.toEqual({ ok: true })
})
