import { BrowserControlError } from "../protocol/desktop-browser.ts"

// Losing a CDP session does not prove that its last DOM/input mutation stopped.
// Keep that uncertainty owned until a positive acknowledgement or target death.
export class BrowserPendingMutations {
  readonly #destroyed: () => boolean
  #pending = new Set<object>()

  constructor(destroyed: () => boolean) {
    this.#destroyed = destroyed
  }

  assertCompleted(): void {
    if (this.#destroyed()) this.#pending.clear()
    if (this.#pending.size)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "A browser mutation has no confirmed completion. Await its acknowledgement or close the original browser target before resuming input.",
      )
  }

  async run(
    command: () => Promise<unknown>,
    closed: AbortSignal,
    completion: "protocol" | "effect" = "protocol",
  ): Promise<unknown> {
    closed.throwIfAborted()
    const marker = {}
    this.#pending.add(marker)
    let dispatched = false
    let rejectClosed: (reason: unknown) => void = () => {}
    const disconnected = new Promise<never>((_resolve, reject) => {
      rejectClosed = reject
    })
    const abort = () =>
      rejectClosed(
        new BrowserControlError(
          "browser_input_unconfirmed",
          "The browser mutation lost its completion channel or exceeded its completion deadline. Do not replay automatically.",
        ),
      )
    closed.addEventListener("abort", abort, { once: true })
    // Install ownership before dispatch, including synchronous disconnects from
    // the native call. Late replies remain handled after the caller has ended.
    const pending = Promise.resolve()
      .then(() => {
        closed.throwIfAborted()
        dispatched = true
        return command()
      })
      .then(
        (value) => {
          this.#pending.delete(marker)
          return value
        },
        (cause: unknown) => {
          if (!dispatched || (completion === "protocol" && !closed.aborted))
            this.#pending.delete(marker)
          throw cause
        },
      )
    try {
      if (closed.aborted) abort()
      return await Promise.race([pending, disconnected])
    } finally {
      closed.removeEventListener("abort", abort)
    }
  }
}
