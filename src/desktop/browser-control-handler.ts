import type { ChildProcess } from "node:child_process"
import {
  BrowserControlError,
  type BrowserOwner,
  type DesktopBrowser,
  type DesktopBrowserResponse,
  parseBrowserOwner,
  parseBrowserRequest,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"

export function bindDesktopBrowserRequests(
  child: ChildProcess,
  browser: DesktopBrowser | undefined,
  report: (cause: unknown) => void,
): void {
  type Active = {
    owner: BrowserOwner
    cancellation: AbortController
    settled: Promise<void>
  }
  let closed = false
  const active = new Map<string, Active>()
  const sessions = new Set<string>()
  const requests = new Set<string>(),
    finishing = new Map<
      string,
      { owner: BrowserOwner; settled: Promise<void> }
    >(),
    closing = new Set<string>()
  const ownerKey = (owner: BrowserOwner) =>
    JSON.stringify([owner.sessionId, owner.turnId])
  const send = (response: DesktopBrowserResponse) => {
    if (child.connected)
      child.send(response, (error) => {
        if (error) report(error)
      })
  }
  const reply = async (
    requestId: string,
    run: () => Promise<JsonObject>,
    signal?: AbortSignal,
    mutationMayHaveRun: () => "input" | "navigate" | undefined = () =>
      undefined,
  ) => {
    try {
      const result = await run()
      signal?.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024)
        throw new Error(
          "Desktop browser reply exceeded its IPC safety boundary.",
        )
      send({ type: "desktop_browser/response", requestId, ok: true, result })
    } catch (cause) {
      // Cancellation does not prove that owned input was released. Preserve
      // that failure so the sidecar can quarantine all computer input.
      if (
        signal?.aborted &&
        !(
          cause instanceof BrowserControlError &&
          cause.code === "browser_cleanup_failed"
        )
      )
        send({
          type: "desktop_browser/response",
          requestId,
          ok: false,
          code:
            mutationMayHaveRun() === "navigate"
              ? "browser_navigation_unconfirmed"
              : mutationMayHaveRun() === "input"
                ? "browser_input_unconfirmed"
                : "browser_cancelled",
          error: mutationMayHaveRun()
            ? "The browser operation may have taken effect before cancellation. Inspect the current target; never replay it automatically."
            : "Browser observation stopped.",
        })
      else if (cause instanceof BrowserControlError) {
        if (cause.code === "browser_cleanup_failed") report(cause)
        send({
          type: "desktop_browser/response",
          requestId,
          ok: false,
          code: cause.code,
          error: cause.message,
        })
      } else {
        report(cause)
        send({
          type: "desktop_browser/response",
          requestId,
          ok: false,
          code: "browser_internal_error",
          error: "Browser operation failed. See desktop diagnostics.",
        })
      }
    } finally {
      requests.delete(requestId)
    }
  }
  const drain = async (matches: (owner: BrowserOwner) => boolean) => {
    const pending = [...active.values()].filter((entry) => matches(entry.owner))
    for (const entry of pending) entry.cancellation.abort()
    await Promise.all(pending.map((entry) => entry.settled))
  }
  child.on("message", (value: unknown) => {
    if (
      closed ||
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
      active.get(requestId)?.cancellation.abort()
      return
    }
    if (requests.has(requestId)) return
    requests.add(requestId)
    // Start on a microtask so active is registered before its first operation.
    const parsedOwner = () =>
      parseBrowserOwner("owner" in value ? value.owner : undefined)
    if ("operation" in value && value.operation === "request") {
      if (active.size >= 4) {
        void reply(requestId, async () => {
          throw new BrowserControlError(
            "browser_busy",
            "The desktop browser safety bound is four active requests.",
          )
        })
        return
      }
      const cancellation = new AbortController()
      let owner: BrowserOwner, input: ReturnType<typeof parseBrowserRequest>
      let attempted = false
      try {
        owner = parsedOwner()
        input = parseBrowserRequest("input" in value ? value.input : undefined)
      } catch (cause) {
        void reply(requestId, async () => {
          throw cause
        })
        return
      }
      sessions.add(owner.sessionId)
      const settled = Promise.resolve()
        .then(() =>
          reply(
            requestId,
            async () => {
              if (!browser)
                throw new BrowserControlError(
                  "browser_unavailable",
                  "Desktop browser control is unavailable in this host.",
                )
              if (
                finishing.has(ownerKey(owner)) ||
                closing.has(owner.sessionId)
              )
                throw new BrowserControlError(
                  "browser_busy",
                  "Browser cleanup is in progress or the four-request safety bound was reached.",
                )
              attempted = true
              return browser.request(input, owner, cancellation.signal)
            },
            cancellation.signal,
            () =>
              attempted
                ? input.action === "navigate"
                  ? "navigate"
                  : input.action === "list" ||
                      input.action === "observe" ||
                      input.action === "capture"
                    ? undefined
                    : "input"
                : undefined,
          ),
        )
        .finally(() => {
          active.delete(requestId)
        })
      active.set(requestId, { owner, cancellation, settled })
      return
    }
    void reply(requestId, async () => {
      if (!browser)
        throw new BrowserControlError(
          "browser_unavailable",
          "Desktop browser control is unavailable in this host.",
        )
      if ("operation" in value && value.operation === "finishTurn") {
        const owner = parsedOwner(),
          key = ownerKey(owner)
        if (finishing.has(key) || closing.has(owner.sessionId))
          throw new BrowserControlError(
            "browser_busy",
            "Browser cleanup is already in progress.",
          )
        const settled = (async () => {
          await drain((current) => ownerKey(current) === key)
          await browser.finishTurn(owner)
        })()
        finishing.set(key, { owner, settled })
        try {
          await settled
        } finally {
          finishing.delete(key)
        }
      } else if (
        "operation" in value &&
        value.operation === "closeSession" &&
        "sessionId" in value &&
        typeof value.sessionId === "string" &&
        /^[A-Za-z0-9_-]{1,256}$/.test(value.sessionId)
      ) {
        const sessionId = value.sessionId
        if (closing.has(sessionId))
          throw new BrowserControlError(
            "browser_busy",
            "Browser session cleanup is already in progress.",
          )
        closing.add(sessionId)
        try {
          await drain((owner) => owner.sessionId === sessionId)
          await Promise.allSettled(
            [...finishing.values()]
              .filter((entry) => entry.owner.sessionId === sessionId)
              .map((entry) => entry.settled),
          )
          await browser.closeSession(sessionId)
          sessions.delete(sessionId)
        } finally {
          closing.delete(sessionId)
        }
      } else
        throw new BrowserControlError(
          "invalid_arguments",
          "Unknown desktop browser lifecycle operation.",
        )
      return {}
    })
  })
  const close = () => {
    if (closed) return
    closed = true
    void (async () => {
      await drain(() => true)
      await Promise.allSettled(
        [...finishing.values()].map((entry) => entry.settled),
      )
      // The connection may be idle between model steps, so ask the adapter to
      // close every session it owns, including those with no active request.
      const results = await Promise.allSettled(
        [...sessions].map((id) => browser?.closeSession(id)),
      )
      for (const result of results)
        if (result.status === "rejected") report(result.reason)
    })().catch(report)
  }
  child.once("exit", close)
  child.once("disconnect", close)
}
