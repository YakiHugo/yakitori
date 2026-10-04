import { isKernelEvent, type StoredEventEnvelope } from "../kernel/index.ts"
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
  // Display-only recovery safety budgets, independent of provider quotas:
  // at most 2 MiB of UTF-16 text plus 256 item records across all sessions.
  // Evicted prefixes are explicitly partial via their nonzero chunk offset.
  const maxDisplayCharacters = 1024 * 1024
  const maxDisplayItems = 256
  type DisplayDelta = Extract<
    LiveSessionEvent,
    { type: "assistant.delta" | "reasoning.delta" }
  >
  const display = new Map<string, DisplayDelta>()
  let displayCharacters = 0
  const keyOf = (event: {
    sessionId: string
    turnId: string
    itemId: string
  }) => JSON.stringify([event.sessionId, event.turnId, event.itemId])
  const removeDisplay = (key: string): void => {
    displayCharacters -= display.get(key)?.delta.length ?? 0
    display.delete(key)
  }
  const clearTurn = (sessionId: string, turnId?: string): void => {
    for (const [key, event] of display) {
      if (
        event.sessionId === sessionId &&
        (turnId === undefined || event.turnId === turnId)
      )
        removeDisplay(key)
    }
  }
  const retainDisplay = (event: DisplayDelta): void => {
    const key = keyOf(event)
    const cached = display.get(key)
    const previous = cached?.streamId === event.streamId ? cached : undefined
    const end =
      previous === undefined ? 0 : previous.offset + previous.delta.length
    if (previous !== undefined && event.offset + event.delta.length <= end)
      return
    const next =
      previous !== undefined && event.offset <= end
        ? {
            ...previous,
            delta: previous.delta + event.delta.slice(end - event.offset),
          }
        : event
    removeDisplay(key)
    display.set(key, next)
    displayCharacters += next.delta.length
    while (
      display.size > maxDisplayItems ||
      displayCharacters > maxDisplayCharacters
    ) {
      const oldest = display.entries().next().value
      if (oldest === undefined) break
      const [oldKey, old] = oldest
      let excess = displayCharacters - maxDisplayCharacters
      // Never start a retained suffix halfway through a UTF-16 surrogate pair.
      if (
        excess > 0 &&
        old.delta.charCodeAt(excess - 1) >= 0xd800 &&
        old.delta.charCodeAt(excess - 1) <= 0xdbff &&
        old.delta.charCodeAt(excess) >= 0xdc00 &&
        old.delta.charCodeAt(excess) <= 0xdfff
      )
        excess += 1
      if (display.size <= maxDisplayItems && excess < old.delta.length) {
        display.set(oldKey, {
          ...old,
          offset: old.offset + excess,
          delta: old.delta.slice(excess),
        })
        displayCharacters -= excess
      } else removeDisplay(oldKey)
    }
  }
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
        for (const event of sessionEvents) {
          if (!isKernelEvent(event)) continue
          if (event.type === "turn.started") clearTurn(sessionId)
          if (event.type === "turn.completed")
            clearTurn(sessionId, event.data.turnId)
          if (event.type === "item.completed")
            removeDisplay(
              keyOf({
                sessionId,
                turnId: event.data.turnId,
                itemId: event.data.item.itemId,
              }),
            )
        }
        publish(sessionId, { kind: "durable", events: sessionEvents })
      }
    },
    publishTransient(event) {
      if (event.type === "assistant.delta" || event.type === "reasoning.delta")
        retainDisplay(event)
      if (event.type === "item.discarded") removeDisplay(keyOf(event))
      if (event.type === "turn.finished")
        clearTurn(event.sessionId, event.turnId)
      publish(event.sessionId, { kind: "transient", event })
    },
    subscribe(sessionId, listener) {
      const sessionSubscribers = subscribers.get(sessionId) ?? new Set()
      const subscriber: Subscriber = {
        listener,
        // Capture and enqueue synchronously before any later publication.
        // The subscription owner buffers these behind durable replay, whose
        // completions remain authoritative over the unfinished display cache.
        pending: [...display.values()]
          .filter((event) => event.sessionId === sessionId)
          .map((event) => ({
            kind: "transient",
            event: { ...event, snapshot: true },
          })),
        delivering: false,
        closed: false,
      }
      sessionSubscribers.add(subscriber)
      subscribers.set(sessionId, sessionSubscribers)
      drain(subscriber)
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
