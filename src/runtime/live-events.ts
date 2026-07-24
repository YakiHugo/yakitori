export type LiveAssistantSnapshot = {
  readonly type: "assistant.snapshot"
  readonly sessionId: string
  readonly turnId: string
  readonly streamId: string
  readonly text: string
  readonly createdAt: string
}

export type LiveSessionEvent = LiveAssistantSnapshot

export type LiveEventListener = (
  event: LiveSessionEvent,
) => void | Promise<void>

export type LiveEventSubscription = {
  close(): void
}

export type TransientEventHub = {
  publish(event: LiveSessionEvent): void
  subscribe(
    sessionId: string,
    listener: LiveEventListener,
  ): LiveEventSubscription
}

export type TransientEventHubOptions = {
  readonly onListenerError?: (error: unknown) => void
}

export function createTransientEventHub(
  options: TransientEventHubOptions = {},
): TransientEventHub {
  const listeners = new Map<string, Set<LiveEventListener>>()

  return {
    publish(event) {
      for (const listener of Array.from(listeners.get(event.sessionId) ?? [])) {
        try {
          void Promise.resolve(listener(event)).catch((error) => {
            options.onListenerError?.(error)
          })
        } catch (error) {
          options.onListenerError?.(error)
        }
      }
    },
    subscribe(sessionId, listener) {
      const sessionListeners = listeners.get(sessionId) ?? new Set()
      sessionListeners.add(listener)
      listeners.set(sessionId, sessionListeners)
      return {
        close() {
          const current = listeners.get(sessionId)
          if (!current) return
          current.delete(listener)
          if (current.size === 0) listeners.delete(sessionId)
        },
      }
    },
  }
}

export type SnapshotPublisher = {
  publish(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly streamId: string
    readonly text: string
  }): void
  flush(): void
}

export function createCoalescingSnapshotPublisher(
  hub: TransientEventHub,
  publicationsPerSecond: number,
): SnapshotPublisher {
  const minIntervalMs = Math.max(1, Math.floor(1000 / publicationsPerSecond))
  let pending:
    | {
        readonly sessionId: string
        readonly turnId: string
        readonly streamId: string
        readonly text: string
      }
    | undefined
  let lastPublishedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const publishNow = (input: {
    readonly sessionId: string
    readonly turnId: string
    readonly streamId: string
    readonly text: string
  }) => {
    lastPublishedAt = Date.now()
    hub.publish({
      type: "assistant.snapshot",
      sessionId: input.sessionId,
      turnId: input.turnId,
      streamId: input.streamId,
      text: input.text,
      createdAt: new Date().toISOString(),
    })
  }

  return {
    publish(input) {
      const now = Date.now()
      if (now - lastPublishedAt >= minIntervalMs) {
        pending = undefined
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        publishNow(input)
        return
      }

      pending = input
      if (timer !== undefined) return
      timer = setTimeout(
        () => {
          timer = undefined
          if (pending === undefined) return
          const next = pending
          pending = undefined
          publishNow(next)
        },
        minIntervalMs - (now - lastPublishedAt),
      )
    },
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (pending === undefined) return
      const next = pending
      pending = undefined
      publishNow(next)
    },
  }
}
