export type PermissionWaitInput = {
  readonly sessionId: string
  readonly turnId: string
  readonly permissionRequestId: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type PermissionGate = {
  notify(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
  }): void
  wait(input: PermissionWaitInput): Promise<"resolved" | "timeout" | "aborted">
}

export type PermissionGateOptions = {
  readonly now?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function createPermissionGate(
  options: PermissionGateOptions = {},
): PermissionGate {
  const waiters = new Map<string, Set<() => void>>()
  const now = options.now ?? (() => Date.now())
  const sleep =
    options.sleep ??
    ((ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"))
          return
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new DOMException("Aborted", "AbortError"))
        }
        signal?.addEventListener("abort", onAbort, { once: true })
      }))

  const keyOf = (input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
  }) => `${input.sessionId}:${input.turnId}:${input.permissionRequestId}`

  return {
    notify(input) {
      const waitersForKey = waiters.get(keyOf(input))
      if (!waitersForKey) return
      for (const wake of Array.from(waitersForKey)) wake()
    },
    async wait(input) {
      const key = keyOf(input)
      const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000
      if (timeoutMs <= 0) return "timeout"
      const deadline = now() + timeoutMs
      if (input.signal?.aborted) return "aborted"

      const set = waiters.get(key) ?? new Set()
      let wake: () => void = () => undefined
      let onAbort: () => void = () => undefined
      const wakePromise = new Promise<"resolved" | "aborted">((resolve) => {
        wake = () => resolve("resolved")
        onAbort = () => resolve("aborted")
        set.add(wake)
        waiters.set(key, set)
        input.signal?.addEventListener("abort", onAbort, { once: true })
      })

      try {
        return await Promise.race([
          wakePromise,
          sleep(Math.min(timeoutMs, 1_000), input.signal).then(() =>
            now() >= deadline ? ("timeout" as const) : ("resolved" as const),
          ),
        ])
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          (error as { name: unknown }).name === "AbortError"
        ) {
          return "aborted"
        }
        throw error
      } finally {
        set.delete(wake)
        if (set.size === 0) waiters.delete(key)
        input.signal?.removeEventListener("abort", onAbort)
      }
    },
  }
}
