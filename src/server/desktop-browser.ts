import { randomUUID } from "node:crypto"
import {
  BrowserControlError,
  type BrowserOperation,
  type DesktopBrowser,
  type DesktopBrowserCancellation,
  type DesktopBrowserRequest,
  isDesktopBrowserResponse,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"

export function createDesktopBrowserClient(): DesktopBrowser & {
  close(): void
} {
  type Pending = {
    resolve: (value: JsonObject) => void
    reject: (cause: unknown) => void
    dispose(): void
    signal?: AbortSignal
  }
  const pending = new Map<string, Pending>()
  let closed = false
  const cancel = (requestId: string) => {
    if (process.connected && process.send) {
      const message: DesktopBrowserCancellation = {
        type: "desktop_browser/cancel",
        requestId,
      }
      process.send(message, (error) => {
        if (!error) return
        const request = pending.get(requestId)
        if (!request) return
        pending.delete(requestId)
        request.dispose()
        request.reject(
          new BrowserControlError("browser_unavailable", error.message),
        )
      })
    }
  }
  const receive = (message: unknown) => {
    if (!isDesktopBrowserResponse(message)) return
    const request = pending.get(message.requestId)
    if (!request) return
    pending.delete(message.requestId)
    request.dispose()
    if (request.signal?.aborted)
      request.reject(
        new BrowserControlError(
          "browser_cancelled",
          "Browser observation stopped.",
        ),
      )
    else if (message.ok) request.resolve(message.result)
    else request.reject(new BrowserControlError(message.code, message.error))
  }
  const close = () => {
    if (closed) return
    closed = true
    process.off("message", receive)
    process.off("disconnect", close)
    for (const [id, request] of pending) {
      cancel(id)
      request.dispose()
      request.reject(
        new BrowserControlError(
          "browser_unavailable",
          "The desktop browser IPC connection closed.",
        ),
      )
    }
    pending.clear()
  }
  const send = (
    operation: BrowserOperation,
    signal?: AbortSignal,
  ): Promise<JsonObject> => {
    signal?.throwIfAborted()
    if (closed || !process.connected || !process.send)
      return Promise.reject(
        new BrowserControlError(
          "browser_unavailable",
          "Use the desktop app for browser control.",
        ),
      )
    const requestId = `browser_${randomUUID()}`
    return new Promise((resolve, reject) => {
      const abort = () => cancel(requestId)
      // Observation has a 10s deadline; allow 2s for IPC teardown. A timed-out
      // request never proves cleanup: finishTurn must still acknowledge it.
      const timer = setTimeout(() => {
        cancel(requestId)
        // A dispatched text insertion cannot be safely abandoned or replayed.
        // Keep this tool pending until the parent acknowledges it. Turn cleanup
        // has its own deadline and retains the lease if that acknowledgement is lost.
        if (
          operation.operation === "request" &&
          operation.input.action === "type"
        )
          return
        pending.delete(requestId)
        dispose()
        reject(
          new BrowserControlError(
            "browser_timeout",
            "The desktop browser did not acknowledge operation cleanup.",
          ),
        )
      }, 12_000)
      timer.unref()
      const dispose = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
      }
      pending.set(requestId, {
        resolve,
        reject,
        dispose,
        ...(signal ? { signal } : {}),
      })
      signal?.addEventListener("abort", abort, { once: true })
      const message: DesktopBrowserRequest = {
        type: "desktop_browser/request",
        requestId,
        ...operation,
      }
      process.send?.(message, (error) => {
        if (!error) return
        pending.delete(requestId)
        dispose()
        reject(new BrowserControlError("browser_unavailable", error.message))
      })
      if (signal?.aborted) abort()
    })
  }
  process.on("message", receive)
  process.once("disconnect", close)
  return {
    close,
    request: (input, owner, signal) =>
      send({ operation: "request", input, owner }, signal),
    async finishTurn(owner) {
      await send({ operation: "finishTurn", owner })
    },
    async closeSession(sessionId) {
      await send({ operation: "closeSession", sessionId })
    },
  }
}
