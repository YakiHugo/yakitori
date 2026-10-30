import type { ChildProcess } from "node:child_process"
import {
  BrowserControlError,
  type DesktopBrowser,
  type DesktopBrowserResponse,
  parseBrowserObservationRequest,
} from "../protocol/desktop-browser.ts"

export function bindDesktopBrowserRequests(
  child: ChildProcess,
  browser: DesktopBrowser | undefined,
  report: (cause: unknown) => void,
): void {
  const pending = new Map<string, AbortController>()
  const send = (response: DesktopBrowserResponse) => {
    if (child.connected)
      child.send(response, (error) => {
        if (error) report(error)
      })
  }
  child.on("message", (value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      !["desktop_browser/request", "desktop_browser/cancel"].includes(
        String(value.type),
      ) ||
      !("requestId" in value) ||
      typeof value.requestId !== "string" ||
      !/^browser_[a-f0-9-]{36}$/.test(value.requestId)
    )
      return
    const requestId = value.requestId
    if (value.type === "desktop_browser/cancel") {
      pending.get(requestId)?.abort()
      return
    }
    if (pending.has(requestId) || pending.size >= 4) {
      send({
        type: "desktop_browser/response",
        requestId,
        ok: false,
        code: "browser_busy",
        error:
          "The desktop browser observation safety bound is four active requests.",
      })
      return
    }
    const cancellation = new AbortController()
    pending.set(requestId, cancellation)
    void (async () => {
      try {
        const input = parseBrowserObservationRequest(
          "input" in value ? value.input : undefined,
        )
        if (!browser)
          throw new BrowserControlError(
            "browser_unavailable",
            "Desktop browser control is unavailable in this host.",
          )
        const result = await browser.request(input, cancellation.signal)
        cancellation.signal.throwIfAborted()
        // The owned producer bounds AX/catalog replies. This second boundary
        // prevents accidental oversized IPC replies from a future adapter.
        if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024)
          throw new Error(
            "Desktop browser reply exceeded its IPC safety boundary.",
          )
        send({ type: "desktop_browser/response", requestId, ok: true, result })
      } catch (cause) {
        if (cancellation.signal.aborted)
          send({
            type: "desktop_browser/response",
            requestId,
            ok: false,
            code: "browser_cancelled",
            error: "Browser observation stopped.",
          })
        else if (cause instanceof BrowserControlError)
          send({
            type: "desktop_browser/response",
            requestId,
            ok: false,
            code: cause.code,
            error: cause.message,
          })
        else {
          report(cause)
          send({
            type: "desktop_browser/response",
            requestId,
            ok: false,
            code: "browser_internal_error",
            error: "Browser observation failed. See desktop diagnostics.",
          })
        }
      } finally {
        pending.delete(requestId)
      }
    })()
  })
  const close = () => {
    for (const cancellation of pending.values()) cancellation.abort()
  }
  child.once("exit", close)
  child.once("disconnect", close)
}
