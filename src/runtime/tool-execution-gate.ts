type GateMode = "parallel" | "exclusive"

type Waiter = {
  readonly mode: GateMode
  readonly signal?: AbortSignal
  ready: boolean
  active: boolean
  cancelled: boolean
  cancellationError?: unknown
  operation?: () => Promise<unknown>
  resolve?: (value: unknown) => void
  reject?: (error: unknown) => void
  onAbort?: () => void
}

export type ToolExecutionReservation = Readonly<{
  run<T>(operation: () => Promise<T>): Promise<T>
  cancel(): void
}>

export type ToolExecutionGate = Readonly<{
  reserve(
    supportsParallel: boolean,
    signal: AbortSignal | undefined,
  ): ToolExecutionReservation
  run<T>(
    supportsParallel: boolean,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T>
}>

export function createToolExecutionGate(): ToolExecutionGate {
  let activeReaders = 0
  let activeWriter = false
  const queue: Waiter[] = []

  const removeAbortListener = (waiter: Waiter) => {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort)
      delete waiter.onAbort
    }
  }

  const release = (mode: GateMode) => {
    if (mode === "parallel") activeReaders -= 1
    else activeWriter = false
    drain()
  }

  const admit = (waiter: Waiter) => {
    waiter.active = true
    removeAbortListener(waiter)
    if (waiter.mode === "parallel") activeReaders += 1
    else activeWriter = true
    const operation = waiter.operation
    if (operation === undefined) {
      throw new Error(
        "Tool execution reservation admitted before it was ready.",
      )
    }
    void Promise.resolve()
      .then(operation)
      .then(waiter.resolve, waiter.reject)
      .finally(() => release(waiter.mode))
  }

  const drain = () => {
    if (activeWriter) return
    while (queue[0]?.cancelled) queue.shift()
    const first = queue[0]
    if (first === undefined || !first.ready) return
    if (activeReaders > 0 && first.mode === "exclusive") return
    if (first.mode === "exclusive") {
      if (activeReaders > 0) return
      queue.shift()
      admit(first)
      return
    }
    while (queue[0]?.mode === "parallel" && queue[0]?.ready) {
      const reader = queue.shift()
      if (reader !== undefined) admit(reader)
      while (queue[0]?.cancelled) queue.shift()
    }
  }

  const reserve = (
    mode: GateMode,
    signal: AbortSignal | undefined,
  ): ToolExecutionReservation => {
    const waiter: Waiter = {
      mode,
      ready: false,
      active: false,
      cancelled: signal?.aborted ?? false,
      ...(signal === undefined ? {} : { signal }),
      ...(signal?.aborted ? { cancellationError: abortReason(signal) } : {}),
    }
    if (!waiter.cancelled) {
      if (signal !== undefined) {
        waiter.onAbort = () => {
          if (waiter.active || waiter.cancelled) return
          waiter.cancelled = true
          waiter.cancellationError = abortReason(signal)
          const index = queue.indexOf(waiter)
          if (index >= 0) queue.splice(index, 1)
          waiter.reject?.(waiter.cancellationError)
          drain()
        }
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }
      queue.push(waiter)
    }

    return {
      run<T>(operation: () => Promise<T>): Promise<T> {
        if (waiter.operation !== undefined) {
          return Promise.reject(
            new Error("Tool execution reservation can only run once."),
          )
        }
        if (waiter.cancelled) {
          return Promise.reject(
            waiter.cancellationError ??
              new DOMException("The operation was cancelled.", "AbortError"),
          )
        }
        waiter.operation = operation
        waiter.ready = true
        const result = new Promise<T>((resolve, reject) => {
          waiter.resolve = resolve as (value: unknown) => void
          waiter.reject = reject
        })
        drain()
        return result
      },
      cancel() {
        if (waiter.active || waiter.cancelled) return
        waiter.cancelled = true
        const index = queue.indexOf(waiter)
        if (index >= 0) queue.splice(index, 1)
        removeAbortListener(waiter)
        waiter.reject?.(
          new DOMException("The operation was cancelled.", "AbortError"),
        )
        drain()
      },
    }
  }

  return {
    reserve(supportsParallel, signal) {
      return reserve(supportsParallel ? "parallel" : "exclusive", signal)
    },
    run(supportsParallel, signal, operation) {
      return reserve(supportsParallel ? "parallel" : "exclusive", signal).run(
        operation,
      )
    },
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  )
}
