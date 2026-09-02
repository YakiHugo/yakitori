export type RequestGateRunResult<T> =
  | Readonly<{ accepted: true; value: T }>
  | Readonly<{ accepted: false }>

export type RequestGate = Readonly<{
  readonly accepting: boolean
  readonly inFlightCount: number
  run<T>(operation: () => Promise<T>): Promise<RequestGateRunResult<T>>
  close(): void
  shutdown(): Promise<void>
}>

// Mirrors Codex's ConnectionRpcGate at the process-wide HTTP boundary. The
// admission check and in-flight registration are synchronous, so close() and
// run() cannot interleave between those two actions on the JavaScript thread.
export function createRequestGate(): RequestGate {
  let accepting = true
  let inFlightCount = 0
  const drained = new Set<() => void>()

  const notifyIfDrained = (): void => {
    if (inFlightCount !== 0) return
    for (const resolve of drained) resolve()
    drained.clear()
  }

  return {
    get accepting() {
      return accepting
    },
    get inFlightCount() {
      return inFlightCount
    },
    async run<T>(operation: () => Promise<T>) {
      if (!accepting) return { accepted: false }
      inFlightCount += 1
      try {
        return { accepted: true, value: await operation() }
      } finally {
        inFlightCount -= 1
        notifyIfDrained()
      }
    },
    close() {
      accepting = false
      notifyIfDrained()
    },
    shutdown() {
      accepting = false
      if (inFlightCount === 0) return Promise.resolve()
      return new Promise<void>((resolve) => drained.add(resolve))
    },
  }
}
