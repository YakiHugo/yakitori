import type { StoredEventEnvelope } from "../kernel/index.ts"
import type { LiveSessionEvent } from "../runtime/live-events.ts"
import {
  consoleOperationalFailureReporter,
  type OperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"

export type SessionDelivery =
  | {
      readonly kind: "durable"
      readonly events: readonly StoredEventEnvelope[]
    }
  | { readonly kind: "transient"; readonly event: LiveSessionEvent }

export type SessionDeliveryListener = (
  delivery: SessionDelivery,
) => void | Promise<void>

export type SessionEventSubscription = {
  close(): void
}

export type SessionEventHub = {
  publishDurable(events: readonly StoredEventEnvelope[]): void
  publishTransient(event: LiveSessionEvent): void
  subscribe(
    sessionId: string,
    listener: SessionDeliveryListener,
  ): SessionEventSubscription
}

export type SessionEventHubOptions = {
  readonly reportOperationalFailure?: OperationalFailureReporter
}

type Subscriber = {
  readonly listener: SessionDeliveryListener
  readonly pending: SessionDelivery[]
  delivering: boolean
  closed: boolean
}

export function createSessionEventHub(
  options: SessionEventHubOptions = {},
): SessionEventHub {
  const subscribers = new Map<string, Set<Subscriber>>()
  const reporter =
    options.reportOperationalFailure ?? consoleOperationalFailureReporter

  const reportListenerFailure = (
    delivery: SessionDelivery,
    error: unknown,
  ): void => {
    const firstEvent =
      delivery.kind === "durable" ? delivery.events[0] : undefined
    const lastEvent =
      delivery.kind === "durable" ? delivery.events.at(-1) : undefined
    const transient = delivery.kind === "transient" ? delivery.event : undefined
    const sessionId =
      delivery.kind === "durable"
        ? firstEvent?.sessionId
        : delivery.event.sessionId
    reportOperationalFailure(reporter, {
      component: "session-event-hub",
      operation: "deliver",
      cause: error,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(transient !== undefined && "turnId" in transient
        ? { turnId: transient.turnId }
        : {}),
      ...(firstEvent === undefined || lastEvent === undefined
        ? {}
        : { eventRange: { from: firstEvent.seq, through: lastEvent.seq } }),
    })
  }

  const drain = (subscriber: Subscriber): void => {
    if (subscriber.closed || subscriber.delivering) return
    for (;;) {
      const delivery = subscriber.pending.shift()
      if (delivery === undefined) return
      try {
        const result = subscriber.listener(delivery)
        if (result === undefined) continue
        subscriber.delivering = true
        void Promise.resolve(result)
          .catch((error) => reportListenerFailure(delivery, error))
          .finally(() => {
            subscriber.delivering = false
            drain(subscriber)
          })
        return
      } catch (error) {
        reportListenerFailure(delivery, error)
      }
    }
  }

  const publish = (sessionId: string, delivery: SessionDelivery): void => {
    for (const subscriber of Array.from(subscribers.get(sessionId) ?? [])) {
      subscriber.pending.push(delivery)
      drain(subscriber)
    }
  }

  return {
    publishDurable(events) {
      for (const [sessionId, sessionEvents] of groupEventsBySession(events)) {
        publish(sessionId, { kind: "durable", events: sessionEvents })
      }
    },
    publishTransient(event) {
      publish(event.sessionId, { kind: "transient", event })
    },
    subscribe(sessionId, listener) {
      const sessionSubscribers = subscribers.get(sessionId) ?? new Set()
      const subscriber: Subscriber = {
        listener,
        pending: [],
        delivering: false,
        closed: false,
      }
      sessionSubscribers.add(subscriber)
      subscribers.set(sessionId, sessionSubscribers)
      return {
        close() {
          subscriber.closed = true
          subscriber.pending.length = 0
          sessionSubscribers.delete(subscriber)
          if (sessionSubscribers.size === 0) subscribers.delete(sessionId)
        },
      }
    },
  }
}

function groupEventsBySession(
  events: readonly StoredEventEnvelope[],
): Map<string, StoredEventEnvelope[]> {
  const grouped = new Map<string, StoredEventEnvelope[]>()
  for (const event of events) {
    grouped.set(event.sessionId, [
      ...(grouped.get(event.sessionId) ?? []),
      event,
    ])
  }
  return grouped
}
