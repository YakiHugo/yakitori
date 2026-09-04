// Per-connection admission gate mirroring Codex's ConnectionRpcGate: closing
// stops new admissions without ever invoking queued work, while tasks admitted
// before close run to completion. The admission check and running-task
// bookkeeping are synchronous, so close() and submit() cannot interleave on
// the JavaScript thread.
export class ConnectionRpcGate {
  private accepting = true
  private runningCount = 0
  private readonly drainWaiters = new Set<() => void>()

  // Tasks own their error reporting (a handler turns failures into error
  // responses); the gate only tracks completion.
  submit(task: () => void | Promise<void>): boolean {
    if (!this.accepting) return false
    this.runningCount += 1
    const finish = (): void => {
      this.runningCount -= 1
      this.notifyIfDrained()
    }
    void Promise.resolve().then(task).then(finish, finish)
    return true
  }

  close(): void {
    this.accepting = false
    this.notifyIfDrained()
  }

  // Resolves once the gate is closed and every admitted task has finished.
  waitForDrain(): Promise<void> {
    if (!this.accepting && this.runningCount === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve)
    })
  }

  async shutdown(timeoutMs: number): Promise<"drained" | "timedOut"> {
    this.close()
    let cancelTimer: (() => void) | undefined
    const timedOut = new Promise<"timedOut">((resolve) => {
      const timer = setTimeout(() => resolve("timedOut"), timeoutMs)
      cancelTimer = () => clearTimeout(timer)
    })
    const drained = this.waitForDrain().then((): "drained" => "drained")
    const result = await Promise.race([drained, timedOut])
    cancelTimer?.()
    return result
  }

  isAccepting(): boolean {
    return this.accepting
  }

  private notifyIfDrained(): void {
    if (this.accepting || this.runningCount !== 0) return
    for (const resolve of this.drainWaiters) resolve()
    this.drainWaiters.clear()
  }
}
