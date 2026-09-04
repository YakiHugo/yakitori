import { describe, expect, it } from "vitest"
import { ConnectionRpcGate } from "../../../src/server/rpc/connection-gate.ts"
import {
  RequestSerializationQueues,
  type RequestSerializationScope,
} from "../../../src/server/rpc/serialization.ts"

const sessionScope: RequestSerializationScope = {
  kind: "session",
  sessionId: "s1",
}
const configWrite: RequestSerializationScope = {
  kind: "global",
  name: "config",
}
const configRead: RequestSerializationScope = {
  kind: "globalSharedRead",
  name: "config",
}

describe("RequestSerializationQueues", () => {
  it("runs exclusive tasks for a key strictly FIFO, one at a time", async () => {
    const queues = new RequestSerializationQueues()
    const order: number[] = []
    let active = 0
    let maxActive = 0
    const completions: Promise<void>[] = []
    for (let i = 0; i < 5; i++) {
      const done = deferred<void>()
      completions.push(done.promise)
      queues.enqueue(sessionScope, async () => {
        order.push(i)
        active += 1
        maxActive = Math.max(maxActive, active)
        await flush()
        active -= 1
        done.resolve()
      })
    }
    await Promise.all(completions)
    expect(order).toEqual([0, 1, 2, 3, 4])
    expect(maxActive).toBe(1)
  })

  it("runs a contiguous batch of shared reads concurrently", async () => {
    const queues = new RequestSerializationQueues()
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()]
    let active = 0
    let maxActive = 0
    let started = 0
    const allStarted = deferred<void>()
    const completions = releases.map((release) => {
      const done = deferred<void>()
      queues.enqueue(configRead, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        started += 1
        if (started === releases.length) allStarted.resolve()
        await release.promise
        active -= 1
        done.resolve()
      })
      return done.promise
    })
    await allStarted.promise
    expect(maxActive).toBe(3)
    for (const release of releases) release.resolve()
    await Promise.all(completions)
  })

  it("admits a read arriving during a running batch when no writer is queued", async () => {
    const queues = new RequestSerializationQueues()
    const firstStarted = deferred<void>()
    const firstRelease = deferred<void>()
    queues.enqueue(configRead, async () => {
      firstStarted.resolve()
      await firstRelease.promise
    })
    await firstStarted.promise

    const laterStarted = deferred<void>()
    queues.enqueue(configRead, async () => {
      laterStarted.resolve()
    })
    await laterStarted.promise
    firstRelease.resolve()
  })

  it("serializes shared reads against exclusive writes of the same global name", async () => {
    const queues = new RequestSerializationQueues()
    const firstReadStarted = deferred<void>()
    const firstReadRelease = deferred<void>()
    queues.enqueue(configRead, async () => {
      firstReadStarted.resolve()
      await firstReadRelease.promise
    })
    await firstReadStarted.promise

    let writerRan = false
    const writerStarted = deferred<void>()
    const writerRelease = deferred<void>()
    queues.enqueue(configWrite, async () => {
      writerRan = true
      writerStarted.resolve()
      await writerRelease.promise
    })
    let laterReadRan = false
    const laterReadStarted = deferred<void>()
    queues.enqueue(configRead, async () => {
      laterReadRan = true
      laterReadStarted.resolve()
    })

    // The write waits for the running read, and the later read is queued
    // behind the writer, so neither may start yet.
    await flush()
    expect(writerRan).toBe(false)
    expect(laterReadRan).toBe(false)

    firstReadRelease.resolve()
    await writerStarted.promise
    await flush()
    expect(writerRan).toBe(true)
    expect(laterReadRan).toBe(false)

    writerRelease.resolve()
    await laterReadStarted.promise
    expect(laterReadRan).toBe(true)
  })

  it("skips a queued task whose gate closed and continues the queue", async () => {
    const queues = new RequestSerializationQueues()
    const liveGate = new ConnectionRpcGate()
    const closedGate = new ConnectionRpcGate()
    closedGate.close()

    const firstStarted = deferred<void>()
    const firstRelease = deferred<void>()
    queues.enqueue(
      sessionScope,
      async () => {
        firstStarted.resolve()
        await firstRelease.promise
      },
      liveGate,
    )
    await firstStarted.promise

    let skippedRan = false
    queues.enqueue(
      sessionScope,
      async () => {
        skippedRan = true
      },
      closedGate,
    )
    const thirdDone = deferred<void>()
    queues.enqueue(
      sessionScope,
      async () => {
        thirdDone.resolve()
      },
      liveGate,
    )

    firstRelease.resolve()
    await thirdDone.promise
    await flush()
    expect(skippedRan).toBe(false)
  })

  it("skips a task whose gate closes between dequeue and its first poll", async () => {
    const queues = new RequestSerializationQueues()
    const gate = new ConnectionRpcGate()

    let firstRan = false
    const secondDone = deferred<void>()
    // The first task is dequeued synchronously while the gate is open, but it
    // only polls on a later microtask; closing the gate now lands in between.
    queues.enqueue(
      sessionScope,
      async () => {
        firstRan = true
      },
      gate,
    )
    gate.close()
    queues.enqueue(sessionScope, async () => {
      secondDone.resolve()
    })

    await secondDone.promise
    await flush()
    // The skipped first task must not stall the queue behind it.
    expect(firstRan).toBe(false)
  })
})

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
    },
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
