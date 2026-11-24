import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import { createDesktopBrowserClient } from "../../src/server/desktop-browser.ts"

const owner = { sessionId: "session_fixture", turnId: "turn_fixture" }
const target = {
  tabId: "fixture",
  webContentsId: 1,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}

function fixture() {
  vi.useFakeTimers()
  const messages: { type: string; requestId: string }[] = []
  const ipc = Object.assign(new EventEmitter(), {
    connected: true,
    send(message: (typeof messages)[number]) {
      messages.push(message)
      return true
    },
  })
  const client = createDesktopBrowserClient(
    ipc as unknown as Parameters<typeof createDesktopBrowserClient>[0],
  )
  return { ipc, client, messages }
}

afterEach(() => vi.useRealTimers())

it("allows navigation past the ordinary deadline and bounds missing cancellation acknowledgement", async () => {
  const { client, messages } = fixture()
  try {
    const rejected = expect(
      client.request(
        {
          action: "navigate",
          target,
          fromUrl: "",
          url: "https://fixture.test/",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "browser_timeout" })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(messages.map(({ type }) => type)).toEqual([
      "desktop_browser/request",
    ])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(messages.map(({ type }) => type)).toEqual([
      "desktop_browser/request",
      "desktop_browser/cancel",
    ])
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
  } finally {
    client.close()
  }
})

it("cancels an ordinary read after 15 seconds without waiting for input release", async () => {
  const { client, messages } = fixture()
  try {
    const rejected = expect(
      client.request({ action: "observe", target }, owner),
    ).rejects.toMatchObject({ code: "browser_timeout" })
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(messages.at(-1)?.type).toBe("desktop_browser/cancel")
  } finally {
    client.close()
  }
})

it("preserves the parent's ambiguous mutation evidence after local cancellation", async () => {
  const { client, ipc, messages } = fixture()
  const abort = new AbortController()
  try {
    const rejected = expect(
      client.request(
        {
          action: "navigate",
          target,
          fromUrl: "",
          url: "https://fixture.test/",
        },
        owner,
        abort.signal,
      ),
    ).rejects.toMatchObject({ code: "browser_navigation_unconfirmed" })
    abort.abort()
    ipc.emit("message", {
      type: "desktop_browser/response",
      requestId: messages[0]?.requestId,
      ok: false,
      code: "browser_navigation_unconfirmed",
      error: "Inspect this tab before trying again.",
    })
    await rejected
  } finally {
    client.close()
  }
})
