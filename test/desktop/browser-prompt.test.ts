import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { expect, it } from "vitest"
import {
  type BrowserDialogCommand,
  BrowserPromptAdapter,
} from "../../src/desktop/browser-prompt.ts"
import { BrowserControlError } from "../../src/protocol/desktop-browser.ts"

function fixture(
  options: {
    navigateDuringEnable?: boolean
    loseInstallAck?: boolean
    rejectRestoreOnce?: boolean
  } = {},
) {
  const events = new EventEmitter(),
    closed = new AbortController(),
    calls: {
      method: string
      params: Record<string, unknown>
      sessionId?: string
    }[] = []
  const adapter = new BrowserPromptAdapter({
    on: events.on.bind(events),
    off: events.off.bind(events),
  } as unknown as WebContents["debugger"])
  const scope = {
    document: {
      frameId: "frame",
      documentId: "v1",
      url: "https://owned.test/",
    },
    frame: { reference: "frame_ticket", sessionId: "child_session" },
    closed: closed.signal,
  }
  const emit = (method: string, params: object, sessionId = "child_session") =>
    events.emit("message", {}, method, params, sessionId)
  let rejectedRestore = false
  let lateAck: ((result: unknown) => void) | undefined
  const command: BrowserDialogCommand = async (
    method,
    params = {},
    sessionId,
    confirmed,
  ) => {
    calls.push({ method, params, ...(sessionId ? { sessionId } : {}) })
    if (method === "Runtime.enable") {
      emit("Runtime.executionContextCreated", {
        context: {
          id: 1,
          uniqueId: "wrong-world",
          auxData: { frameId: "frame", isDefault: false },
        },
      })
      emit("Runtime.executionContextCreated", {
        context: {
          id: 2,
          uniqueId: "other-document",
          auxData: { frameId: "other", isDefault: true },
        },
      })
      emit("Runtime.executionContextCreated", {
        context: {
          id: 3,
          uniqueId: "original-world",
          auxData: { frameId: "frame", isDefault: true },
        },
      })
      if (options.navigateDuringEnable)
        emit("Page.frameNavigated", { frame: { id: "frame", loaderId: "v2" } })
    }
    if (
      options.rejectRestoreOnce &&
      method === "Runtime.callFunctionOn" &&
      "objectId" in params &&
      !rejectedRestore
    ) {
      rejectedRestore = true
      return { exceptionDetails: { text: "Restoration rejected" } }
    }
    const result =
      method === "Runtime.callFunctionOn" && "uniqueContextId" in params
        ? { result: { objectId: "original-ticket" } }
        : {}
    if (
      options.loseInstallAck &&
      method === "Runtime.callFunctionOn" &&
      "uniqueContextId" in params
    ) {
      lateAck = confirmed
      throw new BrowserControlError(
        "browser_input_unconfirmed",
        "Native install acknowledgement lost",
      )
    }
    confirmed?.(result)
    return result
  }
  return {
    adapter,
    scope,
    command,
    calls,
    emit,
    events,
    closed,
    confirmLate: () => {
      if (!lateAck) throw new Error("Missing native acknowledgement callback")
      lateAck({ result: { objectId: "original-ticket" } })
    },
  }
}

it("installs only in the original default world and restores its remote ticket before disabling Runtime", async () => {
  const f = fixture()
  try {
    await f.adapter.install(f.scope, f.command)
    expect(f.calls.map((call) => call.method)).toEqual([
      "Runtime.enable",
      "Runtime.callFunctionOn",
    ])
    expect(f.calls[1]).toMatchObject({
      sessionId: "child_session",
      params: {
        uniqueContextId: "original-world",
        arguments: [{ value: "https://owned.test/" }],
      },
    })
    await f.adapter.restore()
    expect(f.calls.slice(2).map((call) => call.method)).toEqual([
      "Runtime.callFunctionOn",
      "Runtime.releaseObjectGroup",
      "Runtime.disable",
    ])
    expect(f.calls[2]).toMatchObject({
      sessionId: "child_session",
      params: { objectId: "original-ticket" },
    })
  } finally {
    f.adapter.close()
  }
  expect(f.events.listenerCount("message")).toBe(0)
})

it("does not install in a new document that navigates while Runtime is enabled", async () => {
  const f = fixture({ navigateDuringEnable: true })
  try {
    await expect(f.adapter.install(f.scope, f.command)).rejects.toMatchObject({
      code: "browser_prompt_unavailable",
    })
    await f.adapter.restore()
    expect(f.calls.map((call) => call.method)).toEqual([
      "Runtime.enable",
      "Runtime.releaseObjectGroup",
      "Runtime.disable",
    ])
  } finally {
    f.adapter.close()
  }
})

it.each([
  "context",
  "session",
  "hash",
])("uses original context lifetime evidence during %s cleanup", async (loss) => {
  const f = fixture()
  try {
    await f.adapter.install(f.scope, f.command)
    if (loss === "context")
      f.emit("Runtime.executionContextDestroyed", {
        executionContextId: 3,
        executionContextUniqueId: "original-world",
      })
    if (loss === "session") f.closed.abort()
    if (loss === "hash")
      f.emit("Page.navigatedWithinDocument", {
        frameId: "frame",
        url: "https://owned.test/#new",
      })
    if (loss === "session") {
      await expect(f.adapter.restore()).rejects.toMatchObject({
        code: "browser_cleanup_failed",
      })
      f.adapter.close(true)
    } else await f.adapter.restore()
    expect(f.calls.slice(2).map((call) => call.method)).toEqual(
      loss === "context"
        ? ["Runtime.disable"]
        : loss === "session"
          ? []
          : [
              "Runtime.callFunctionOn",
              "Runtime.releaseObjectGroup",
              "Runtime.disable",
            ],
    )
  } finally {
    f.adapter.close()
  }
})

it("retains a late positive install acknowledgement so retrying cleanup restores the original wrapper", async () => {
  const f = fixture({ loseInstallAck: true })
  try {
    await expect(f.adapter.install(f.scope, f.command)).rejects.toMatchObject({
      code: "browser_input_unconfirmed",
    })
    f.confirmLate()
    await f.adapter.restore()
    expect(
      f.calls
        .filter((call) => call.method === "Runtime.callFunctionOn")
        .map((call) => call.params.objectId ?? call.params.uniqueContextId),
    ).toEqual(["original-world", "original-ticket"])
  } finally {
    f.adapter.close()
  }
})

it("retains restoration ownership when Chromium reports a JavaScript exception in its positive protocol reply", async () => {
  const f = fixture({ rejectRestoreOnce: true })
  try {
    await f.adapter.install(f.scope, f.command)
    await expect(f.adapter.restore()).rejects.toMatchObject({
      code: "browser_cleanup_failed",
    })
    expect(f.calls.some((call) => call.method === "Runtime.disable")).toBe(
      false,
    )
    await f.adapter.restore()
    expect(f.calls.at(-1)?.method).toBe("Runtime.disable")
  } finally {
    f.adapter.close()
  }
})

it("does not mistake a debugger detach for destruction of its main-world override", async () => {
  const f = fixture()
  try {
    await f.adapter.install(f.scope, f.command)
    f.adapter.disconnected()
    await expect(f.adapter.restore()).rejects.toMatchObject({
      code: "browser_cleanup_failed",
    })
    expect(() => f.adapter.close()).toThrow(/restoration remains owned/)
    expect(f.calls.map((call) => call.method)).toEqual([
      "Runtime.enable",
      "Runtime.callFunctionOn",
    ])
  } finally {
    f.adapter.close(true)
  }
})
