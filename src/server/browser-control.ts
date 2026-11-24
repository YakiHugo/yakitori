import {
  BrowserControlError,
  type BrowserOwner,
  type BrowserRequest,
  browserRequestMutates,
  type DesktopBrowser,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"

type BrowserTurn = {
  owner: BrowserOwner
  interrupt(): Promise<void>
  released: PromiseWithResolvers<void>
  stopping?: Promise<void>
  closing: boolean
}

type TabLease = {
  turn: BrowserTurn
  cleanupPending: boolean
}

export class BrowserControl implements DesktopBrowser {
  readonly #browser: DesktopBrowser
  readonly #turns = new Map<string, BrowserTurn>()
  readonly #tabs = new Map<string, TabLease>()

  constructor(browser: DesktopBrowser) {
    this.#browser = browser
  }

  track(owner: BrowserOwner, interrupt: () => Promise<void>): void {
    const key = JSON.stringify([owner.sessionId, owner.turnId])
    if (this.#turns.has(key))
      throw new Error("Browser turn is already tracked.")
    const released = Promise.withResolvers<void>()
    void released.promise.catch(() => {})
    this.#turns.set(key, { owner, interrupt, released, closing: false })
  }

  async request(
    input: BrowserRequest,
    owner: BrowserOwner,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    signal?.throwIfAborted()
    const turn = this.#turns.get(
      JSON.stringify([owner.sessionId, owner.turnId]),
    )
    if (!turn || turn.closing || turn.stopping)
      throw new BrowserControlError(
        "browser_cancelled",
        "This turn no longer owns browser operations.",
      )
    if (input.action === "list")
      return this.#browser.request(input, owner, signal)
    const tabId = input.target.tabId
    let lease = this.#tabs.get(tabId)
    if (lease?.cleanupPending)
      throw new BrowserControlError(
        "browser_cleanup_pending",
        "This tab cannot be operated until its previous input cleanup is confirmed.",
      )
    if (lease && lease.turn !== turn)
      throw new BrowserControlError(
        "browser_busy",
        "Another turn owns this tab. Choose another tab or wait for that turn to finish.",
      )
    if (!lease) {
      lease = { turn, cleanupPending: false }
      this.#tabs.set(tabId, lease)
    }
    try {
      return await this.#browser.request(input, owner, signal)
    } catch (cause) {
      if (
        cause instanceof BrowserControlError &&
        (cause.code === "browser_cleanup_failed" ||
          (cause.code === "browser_timeout" && browserRequestMutates(input)))
      ) {
        lease.cleanupPending = true
      }
      throw cause
    }
  }

  async finishTurn(owner: BrowserOwner): Promise<void> {
    const key = JSON.stringify([owner.sessionId, owner.turnId])
    const turn = this.#turns.get(key)
    if (!turn) return
    turn.closing = true
    const leases = [...this.#tabs.entries()].filter(
      ([, lease]) => lease.turn === turn,
    )
    try {
      if (leases.length > 0) await this.#browser.finishTurn(owner)
      for (const [tabId] of leases) this.#tabs.delete(tabId)
      this.#turns.delete(key)
      turn.released.resolve()
    } catch (cause) {
      for (const [, lease] of leases) lease.cleanupPending = true
      turn.released.reject(cause)
      throw cause
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#browser.closeSession(sessionId)
    for (const [tabId, lease] of this.#tabs)
      if (lease.turn.owner.sessionId === sessionId) this.#tabs.delete(tabId)
    for (const [key, turn] of this.#turns)
      if (turn.owner.sessionId === sessionId) {
        this.#turns.delete(key)
        turn.released.resolve()
      }
  }

  async takeOver(tabId: string): Promise<void> {
    const turn = this.#tabs.get(tabId)?.turn
    if (!turn) return
    turn.stopping ??= Promise.resolve().then(async () => {
      if (!turn.closing) await turn.interrupt()
      await turn.released.promise
    })
    await turn.stopping
  }
}
