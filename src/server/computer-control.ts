export type ComputerUseOwner = Readonly<{
  sessionId: string
  turnId: string
  interrupt(): Promise<void>
  released: Promise<void>
}>

export class ComputerControlError extends Error {}

// The lease lasts through native cleanup, including between model steps.
// Taking over seals admission synchronously before requesting cancellation.
export class ComputerControl {
  #owner: ComputerUseOwner | undefined
  #takenOver = false
  #stopping: Promise<void> | undefined
  #epoch = 0

  get takenOver(): boolean {
    return this.#takenOver
  }

  get owner(): ComputerUseOwner | undefined {
    return this.#owner
  }

  acquire(
    owner: ComputerUseOwner,
  ): "computer_busy" | "computer_taken_over" | undefined {
    if (this.#takenOver) return "computer_taken_over"
    if (this.#owner && this.#owner !== owner) return "computer_busy"
    this.#owner = owner
    return undefined
  }

  release(owner: ComputerUseOwner): void {
    if (this.#owner === owner) this.#owner = undefined
  }

  releaseSession(sessionId: string): void {
    if (this.#owner?.sessionId === sessionId) this.#owner = undefined
  }

  takeOver(disconnect: () => Promise<void> = async () => {}): Promise<void> {
    this.#takenOver = true
    this.#epoch++
    if (this.#stopping) return this.#stopping
    const owner = this.#owner
    const stopping = Promise.allSettled([
      Promise.resolve().then(disconnect),
      (async () => {
        if (!owner) return
        await owner.interrupt()
        await owner.released
      })(),
    ]).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, "Computer takeover failed.")
    })
    this.#stopping = stopping.finally(() => {
      this.#stopping = undefined
    })
    return this.#stopping
  }

  #assertCanResume(): void {
    if (this.#stopping || this.#owner)
      throw new ComputerControlError(
        "Wait for computer input and native cleanup to stop before reconnecting.",
      )
  }

  prepareResume(): number {
    this.#assertCanResume()
    return this.#epoch
  }

  resume(epoch: number): void {
    this.#assertCanResume()
    if (epoch !== this.#epoch)
      throw new ComputerControlError(
        "The user took over while computer use was connecting. Reconnect again to allow input.",
      )
    this.#takenOver = false
  }
}
