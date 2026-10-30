import { randomUUID } from "node:crypto"
import type { BrowserWindow, WebContents } from "electron"
import {
  BrowserControlError,
  type BrowserOwner,
} from "../protocol/desktop-browser.ts"
import type { WorkspaceBrowserShowResult } from "./workspace-browser-types.ts"

type PendingShow = {
  owner: BrowserOwner
  current: () => boolean
  claimed: boolean
  uncertain: boolean
  resolve: () => void
  reject: (cause: unknown) => void
}

// The renderer claims a live request before mutating its workspace store, then
// acknowledges completion. A claimed request cannot be abandoned on cancellation.
export class BrowserViewRequests {
  readonly #window: BrowserWindow
  readonly #contents: WebContents
  #pending = new Map<string, PendingShow>()
  #closed = false
  readonly #contextGone = () => {
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id)
      entry.reject(
        new BrowserControlError(
          "browser_unavailable",
          "The workspace renderer closed or navigated.",
        ),
      )
    }
  }

  constructor(window: BrowserWindow) {
    this.#window = window
    this.#contents = window.webContents
    this.#contents.on("render-process-gone", this.#contextGone)
    this.#contents.on("did-navigate", this.#contextGone)
    this.#contents.on("destroyed", this.#contextGone)
  }

  assertIdle(): void {
    if (this.#pending.size)
      throw new BrowserControlError(
        [...this.#pending.values()].some((entry) => entry.uncertain)
          ? "browser_cleanup_failed"
          : "browser_busy",
        "A workspace display request still owns its completion. Wait for acknowledgement or close the original workspace window.",
      )
  }

  async show(
    tabId: string,
    owner: BrowserOwner,
    current: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    this.assertIdle()
    if (this.#closed || this.#window.isDestroyed())
      throw new BrowserControlError(
        "browser_unavailable",
        "The workspace window is closed.",
      )
    if (!current())
      throw new BrowserControlError(
        "browser_target_changed",
        "The requested browser target changed.",
      )
    const id = `browser_show_${randomUUID()}`,
      completion = Promise.withResolvers<void>()
    const entry: PendingShow = {
      owner,
      current,
      claimed: false,
      uncertain: false,
      resolve: completion.resolve,
      reject: completion.reject,
    }
    this.#pending.set(id, entry)
    // Five seconds bounds a renderer acknowledgement, not a UI/product quota.
    const timeout = setTimeout(() => {
      if (this.#pending.get(id) !== entry) return
      if (!entry.claimed) this.#pending.delete(id)
      else entry.uncertain = true
      entry.reject(
        new BrowserControlError(
          entry.claimed ? "browser_cleanup_failed" : "browser_view_unavailable",
          entry.claimed
            ? "The renderer claimed the display request without confirming completion. Wait for acknowledgement or close the workspace window."
            : "The workspace renderer did not claim the display request before its five-second safety deadline.",
        ),
      )
    }, 5000)
    const abort = () => {
      if (this.#pending.get(id) !== entry || entry.claimed) return
      this.#pending.delete(id)
      entry.reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      if (signal.aborted) abort()
      else
        this.#contents.send("yakitori:browser-show-request", {
          requestId: id,
          tabId,
          ownerSessionId: owner.sessionId,
        })
      await completion.promise
    } catch (cause) {
      if (this.#pending.get(id) === entry && entry.claimed) {
        entry.uncertain = true
        throw new BrowserControlError(
          "browser_cleanup_failed",
          "Workspace display completion is unconfirmed.",
          { cause },
        )
      }
      this.#pending.delete(id)
      throw cause
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
    }
  }

  claim(id: string): boolean {
    const entry = this.#pending.get(id)
    if (!entry || entry.claimed) return false
    if (!entry.current()) {
      this.#pending.delete(id)
      entry.reject(
        new BrowserControlError(
          "browser_target_changed",
          "The browser target changed before the display request was claimed.",
        ),
      )
      return false
    }
    entry.claimed = true
    return true
  }

  complete(id: string, result: WorkspaceBrowserShowResult): boolean {
    const entry = this.#pending.get(id)
    if (!entry) return false
    if (result === "applied" && !entry.claimed)
      throw new Error("Workspace display must be claimed before it is applied.")
    this.#pending.delete(id)
    if (result === "applied") entry.resolve()
    else
      entry.reject(
        new BrowserControlError(
          result === "refused"
            ? "browser_view_unavailable"
            : "browser_input_unconfirmed",
          result === "refused"
            ? "The browser tab is not in the currently selected conversation workspace, or settings are open."
            : "The workspace renderer could not confirm the requested display change. Do not replay automatically.",
        ),
      )
    return true
  }

  #finish(matches: (owner: BrowserOwner) => boolean): void {
    for (const [id, entry] of this.#pending) {
      if (!matches(entry.owner)) continue
      if (entry.claimed)
        throw new BrowserControlError(
          "browser_cleanup_failed",
          "A claimed workspace display request has not acknowledged completion.",
        )
      this.#pending.delete(id)
      entry.reject(
        new BrowserControlError(
          "browser_cancelled",
          "The unclaimed workspace display request ended.",
        ),
      )
    }
  }

  finishTurn(owner: BrowserOwner): void {
    this.#finish(
      (candidate) =>
        candidate.sessionId === owner.sessionId &&
        candidate.turnId === owner.turnId,
    )
  }

  closeSession(sessionId: string): void {
    this.#finish((owner) => owner.sessionId === sessionId)
  }

  close(): void {
    this.#closed = true
    this.#contextGone()
    // BrowserWindow.webContents is inaccessible once the window has closed.
    this.#contents.off("render-process-gone", this.#contextGone)
    this.#contents.off("did-navigate", this.#contextGone)
    this.#contents.off("destroyed", this.#contextGone)
  }
}
