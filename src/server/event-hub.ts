import type { EventEnvelope } from "../kernel/index.ts"

export type DurableEventListener = (
  events: readonly EventEnvelope[],
) => void | Promise<void>

export type DurableEventSubscription = {
  close(): void
}

export type DurableEventHub = {
  publish(events: readonly EventEnvelope[]): void
  subscribe(
    sessionId: string,
    listener: DurableEventListener,
  ): DurableEventSubscription
}

export type DurableEventHubOptions = {
  readonly onListenerError?: (error: unknown) => void
}

export function createDurableEventHub(
  options: DurableEventHubOptions = {},
): DurableEventHub {
  const listeners = new Map<string, Set<DurableEventListener>>()

  return {
    publish(events) {
      for (const [sessionId, sessionEvents] of groupEventsBySession(events)) {
        for (const listener of Array.from(listeners.get(sessionId) ?? [])) {
          try {
            void Promise.resolve(listener(sessionEvents)).catch((error) => {
              options.onListenerError?.(error)
            })
          } catch (error) {
            options.onListenerError?.(error)
          }
        }
      }
    },

    subscribe(sessionId, listener) {
      const sessionListeners = listeners.get(sessionId) ?? new Set()
      sessionListeners.add(listener)
      listeners.set(sessionId, sessionListeners)

      return {
        close() {
          sessionListeners.delete(listener)
          if (sessionListeners.size === 0) listeners.delete(sessionId)
        },
      }
    },
  }
}

function groupEventsBySession(
  events: readonly EventEnvelope[],
): Map<string, EventEnvelope[]> {
  const grouped = new Map<string, EventEnvelope[]>()
  for (const event of events) {
    grouped.set(event.sessionId, [
      ...(grouped.get(event.sessionId) ?? []),
      event,
    ])
  }
  return grouped
}
