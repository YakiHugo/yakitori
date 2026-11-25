import type { SessionStream } from "../lib/rpc-client.ts"

export type RetainedSessionStream = Readonly<{
  source: SessionStream
  ready(): boolean
  activate(revision: number): void
}>

// Codex Desktop 26.1106.51428 uses maxInactiveOwnerThreads = 10
// and ttlMs = 10_800_000. Bound resources held by idle subscriptions;
// active Turns keep their subscription through completion.
const maxIdleStreams = 10
const idleLifetimeMs = 3 * 60 * 60 * 1000

export class BackgroundSessionStreams {
  readonly #streams = new Map<
    string,
    {
      stream: RetainedSessionStream
      idleSince: number | undefined
    }
  >()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly discardView: (key: string) => void) {}

  get(key: string): RetainedSessionStream | undefined {
    return this.#streams.get(key)?.stream
  }

  park(key: string, stream: RetainedSessionStream, active: boolean): void {
    this.#streams.set(key, {
      stream,
      idleSince: active ? undefined : Date.now(),
    })
    this.#expireIdle()
  }

  updateActivity(key: string, active: boolean): void {
    const entry = this.#streams.get(key)
    if (entry === undefined || active === (entry.idleSince === undefined))
      return
    entry.idleSince = active ? undefined : Date.now()
    this.#streams.delete(key)
    this.#streams.set(key, entry)
    this.#expireIdle()
  }

  take(key: string): RetainedSessionStream | undefined {
    const entry = this.#streams.get(key)
    if (!entry) return undefined
    this.#streams.delete(key)
    this.#expireIdle()
    return entry.stream
  }

  drop(key: string): void {
    const entry = this.#streams.get(key)
    if (entry === undefined) return
    this.#streams.delete(key)
    this.discardView(key)
    entry.stream.source.close()
    this.#expireIdle()
  }

  clear(): void {
    const streams = [...this.#streams]
    this.#streams.clear()
    clearTimeout(this.#timer)
    this.#timer = undefined
    for (const [key, { stream }] of streams) {
      this.discardView(key)
      stream.source.close()
    }
  }

  #expireIdle(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    const now = Date.now()
    const idle = [...this.#streams]
      .flatMap(([key, entry]) =>
        entry.idleSince === undefined ? [] : [{ key, since: entry.idleSince }],
      )
      .sort((left, right) => left.since - right.since)
    const overage = Math.max(0, idle.length - maxIdleStreams)
    for (const [index, { key, since }] of idle.entries()) {
      const remaining = since + idleLifetimeMs - now
      if (index >= overage && remaining > 0) {
        this.#timer = setTimeout(() => this.#expireIdle(), remaining)
        break
      }
      const entry = this.#streams.get(key)
      this.#streams.delete(key)
      this.discardView(key)
      entry?.stream.source.close()
    }
  }
}
