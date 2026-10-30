import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserDialogs } from "../../src/desktop/browser-dialogs.ts"
import { BrowserControlError } from "../../src/protocol/desktop-browser.ts"

function fixture(sessionId?: string) {
  const events = new EventEmitter(),
    closed = new AbortController(),
    response = Promise.withResolvers<void>(),
    calls: string[] = []
  const dialogs = new BrowserDialogs({
    on: events.on.bind(events),
    off: events.off.bind(events),
  } as unknown as WebContents["debugger"])
  const scope = {
    document: {
      frameId: "original",
      documentId: "v1",
      url: "https://owned.test/",
    },
    ...(sessionId ? { frame: { reference: "frame_ticket", sessionId } } : {}),
    closed: closed.signal,
  }
  let confirmed: (() => void) | undefined
  const command = async (
    method: string,
    _params?: Record<string, unknown>,
    _sessionId?: string,
    ack?: () => void,
  ) => {
    confirmed = ack
    calls.push(method)
    if (method === "Page.handleJavaScriptDialog") await response.promise
    return {}
  }
  const emit = (
    params: object,
    source = sessionId ?? "",
    method = "Page.javascriptDialogOpening",
  ) => events.emit("message", {}, method, params, source)
  const dialog = {
    frameId: "original",
    url: scope.document.url,
    type: "confirm",
    message: "Approved dialog",
  }
  return {
    dialogs,
    scope,
    command,
    calls,
    emit,
    dialog,
    events,
    response,
    closed,
    confirm: () => {
      if (!confirmed) throw new Error("No pending response")
      confirmed()
    },
  }
}

it.each([
  undefined,
  "original_session",
])("answers a matching dialog once in the original renderer (%s) and awaits native completion", async (sessionId) => {
  const f = fixture(sessionId)
  try {
    // Read-only observation never handles an unsolicited dialog.
    f.emit(f.dialog)
    expect(f.calls).toEqual([])
    await f.dialogs.arm(
      f.scope,
      { type: "confirm", accept: false, message: "Approved dialog" },
      f.command,
    )
    f.emit(f.dialog, "other_renderer")
    expect(f.calls).toEqual(["Page.enable"])
    f.emit(f.dialog)
    f.emit(f.dialog)
    expect(f.calls).toEqual(["Page.enable", "Page.handleJavaScriptDialog"])
    let settled = false
    const settling = f.dialogs.settle().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.response.resolve()
    await settling
    expect(f.dialogs.inspect()).toMatchObject({
      state: "answered",
      expired: false,
    })
    await f.dialogs.disarm()
    f.emit(f.dialog)
    expect(f.calls).toHaveLength(2)
    expect(f.dialogs.inspect()).toEqual({ armed: false })
  } finally {
    f.dialogs.close()
  }
  expect(f.events.listenerCount("message")).toBe(0)
})

it.each([
  "frame",
  "url",
  "type",
  "message",
  "navigation",
  "hash",
  "closed",
])("does not reply after %s differs from the approved document/rule", async (difference) => {
  const f = fixture()
  try {
    await f.dialogs.arm(
      f.scope,
      { type: "confirm", accept: true, message: "Approved dialog" },
      f.command,
    )
    if (difference === "navigation")
      f.emit(
        { frame: { id: "original", loaderId: "v2" } },
        "",
        "Page.frameNavigated",
      )
    if (difference === "hash")
      f.emit(
        { frameId: "original", url: "https://owned.test/#new" },
        "",
        "Page.navigatedWithinDocument",
      )
    if (difference === "closed") f.closed.abort()
    f.emit({
      ...f.dialog,
      ...(difference === "frame"
        ? { frameId: "other" }
        : difference === "url"
          ? { url: "https://other.test/" }
          : difference === "type"
            ? { type: "alert" }
            : difference === "message"
              ? { message: "Unexpected" }
              : {}),
    })
    await f.dialogs.settle()
    expect(f.calls).toEqual(["Page.enable"])
    expect(f.dialogs.inspect()).toMatchObject(
      ["navigation", "hash", "closed"].includes(difference)
        ? { expired: true, state: "waiting" }
        : { state: "mismatch" },
    )
  } finally {
    f.dialogs.close()
  }
})

it("retains an unconfirmed response failure for input and turn cleanup", async () => {
  const f = fixture()
  try {
    await f.dialogs.arm(f.scope, { type: "confirm", accept: true }, f.command)
    f.emit(f.dialog)
    f.response.reject(
      new BrowserControlError("browser_cleanup_failed", "Unknown response"),
    )
    await expect(f.dialogs.settle()).rejects.toMatchObject({
      code: "browser_cleanup_failed",
    })
    await expect(f.dialogs.disarm()).rejects.toMatchObject({
      code: "browser_cleanup_failed",
    })
    expect(f.dialogs.inspect()).toMatchObject({ state: "answering" })
    f.confirm()
    await f.dialogs.settle()
    await f.dialogs.disarm()
    expect(f.calls).toEqual(["Page.enable", "Page.handleJavaScriptDialog"])
    expect(f.dialogs.inspect()).toEqual({ armed: false })
  } finally {
    f.dialogs.close()
  }
})
