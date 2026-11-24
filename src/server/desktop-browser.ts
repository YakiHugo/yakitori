import { randomUUID } from "node:crypto"
import {
  BrowserControlError,
  type BrowserOperation,
  browserRequestMutates,
  type DesktopBrowser,
  type DesktopBrowserCancellation,
  type DesktopBrowserRequest,
  isDesktopBrowserResponse,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"

type BrowserIpc = Pick<
  NodeJS.Process,
  "connected" | "send" | "on" | "off" | "once"
>

export function createDesktopBrowserClient(
  ipc: BrowserIpc = process,
): DesktopBrowser & {
  close(): void
} {
  type Pending = {
    resolve: (value: JsonObject) => void
    reject: (cause: unknown) => void
    dispose(): void
    signal?: AbortSignal
    mutating: boolean
  }
  const pending = new Map<string, Pending>()
  let closed = false
  const cancel = (requestId: string) => {
    if (ipc.connected && ipc.send) {
      const message: DesktopBrowserCancellation = {
        type: "desktop_browser/cancel",
        requestId,
      }
      ipc.send(message, (error) => {
        if (!error) return
        const request = pending.get(requestId)
        if (!request) return
        pending.delete(requestId)
        request.dispose()
        request.reject(
          new BrowserControlError(
            request.mutating ? "browser_cleanup_failed" : "browser_unavailable",
            error.message,
          ),
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
    if (
      !message.ok &&
      [
        "browser_cleanup_failed",
        "browser_input_unconfirmed",
        "browser_navigation_unconfirmed",
      ].includes(message.code)
    )
      request.reject(new BrowserControlError(message.code, message.error))
    else if (request.signal?.aborted)
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
    ipc.off("message", receive)
    ipc.off("disconnect", close)
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
    if (closed || !ipc.connected || !ipc.send)
      return Promise.reject(
        new BrowserControlError(
          "browser_unavailable",
          "Use the desktop app for browser control.",
        ),
      )
    const requestId = `browser_${randomUUID()}`
    return new Promise((resolve, reject) => {
      const mutating =
        operation.operation === "request" &&
        browserRequestMutates(operation.input)
      const action: string | undefined =
        operation.operation === "request" ? operation.input.action : undefined
      const operationDeadline =
        action && ["navigate", "wait", "download_wait"].includes(action)
          ? 45_000
          : 15_000
      let grace: ReturnType<typeof setTimeout> | undefined
      let cancelling = false
      const fail = (code: string, message: string) => {
        if (!pending.has(requestId)) return
        pending.delete(requestId)
        dispose()
        reject(new BrowserControlError(code, message))
      }
      const abort = () => stop(false)
      const stop = (timedOut: boolean) => {
        if (cancelling) return
        cancelling = true
        clearTimeout(timer)
        if (mutating) {
          // Bound the wait for input release; no acknowledgement means the
          // owning tab must remain quarantined until turn cleanup succeeds.
          grace = setTimeout(
            () =>
              fail(
                "browser_timeout",
                "The desktop did not confirm input cleanup. Inspect the tab after cleanup; do not replay this operation.",
              ),
            5_000,
          )
          grace.unref()
          cancel(requestId)
        } else {
          cancel(requestId)
          fail(
            timedOut ? "browser_timeout" : "browser_cancelled",
            timedOut
              ? "The desktop browser operation exceeded its time safety boundary."
              : "Browser observation stopped.",
          )
        }
      }
      const timer = setTimeout(() => stop(true), operationDeadline)
      timer.unref()
      const dispose = () => {
        clearTimeout(timer)
        clearTimeout(grace)
        signal?.removeEventListener("abort", abort)
      }
      pending.set(requestId, {
        resolve,
        reject,
        dispose,
        mutating,
        ...(signal ? { signal } : {}),
      })
      signal?.addEventListener("abort", abort, { once: true })
      const message: DesktopBrowserRequest = {
        type: "desktop_browser/request",
        requestId,
        ...operation,
      }
      ipc.send?.(message, (error) => {
        if (!error) return
        fail("browser_unavailable", error.message)
      })
      if (signal?.aborted) abort()
    })
  }
  ipc.on("message", receive)
  ipc.once("disconnect", close)
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
