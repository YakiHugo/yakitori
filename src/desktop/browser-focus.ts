import { BrowserControlError } from "../protocol/desktop-browser.ts"

type FocusCommand = (
  enabled: boolean,
  confirmed?: () => void,
) => Promise<unknown>

// CDP page focus lets an embedded Chromium widget receive its first press.
// It never focuses the OS window or WebContentsView. Keep the override owned
// through button-up, including a lost configuration ACK and late restoration.
export class BrowserPageFocus {
  #command: FocusCommand | undefined

  get active(): boolean {
    return this.#command !== undefined
  }

  async enable(command: FocusCommand): Promise<void> {
    if (this.#command) throw new Error("Browser page focus is already owned.")
    this.#command = command
    await command(true)
  }

  async cleanup(destroyed: boolean): Promise<void> {
    const command = this.#command
    if (!command) return
    if (destroyed) {
      this.#command = undefined
      return
    }
    try {
      await command(false, () => {
        if (this.#command === command) this.#command = undefined
      })
    } catch (cause) {
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Browser page focus emulation did not confirm restoration. Computer input remains quarantined until cleanup succeeds or the original tab closes.",
        { cause },
      )
    }
  }
}
