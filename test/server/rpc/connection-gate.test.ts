import { describe, expect, it } from "vitest"
import { ConnectionRpcGate } from "../../../src/server/rpc/connection-gate.ts"

describe("ConnectionRpcGate", () => {
  it("runs tasks submitted while accepting", async () => {
    const gate = new ConnectionRpcGate()
    const ran = deferred<void>()
    expect(gate.submit(() => ran.resolve())).toBe(true)
    await ran.promise
  })

  it("never invokes a task submitted after close", async () => {
    const gate = new ConnectionRpcGate()
    gate.close()
    let invoked = false
    expect(
      gate.submit(() => {
        invoked = true
      }),
    ).toBe(false)
    await flush()
    expect(invoked).toBe(false)
    expect(gate.isAccepting()).toBe(false)
  })

  it("shutdown closes admission and reports drained once running tasks finish", async () => {
    const gate = new ConnectionRpcGate()
    const started = deferred<void>()
    const release = deferred<void>()
    gate.submit(async () => {
      started.resolve()
      await release.promise
    })
    await started.promise

    let drained = false
    const shutdown = gate.shutdown(1000).then((result) => {
      drained = true
      return result
    })
    const repeatedShutdown = gate.shutdown(1000)
    expect(gate.isAccepting()).toBe(false)
    await flush()
    expect(drained).toBe(false)
    release.resolve()
    await expect(Promise.all([shutdown, repeatedShutdown])).resolves.toEqual([
      "drained",
      "drained",
    ])
  })

  it("shutdown reports timedOut on a never-finishing task", async () => {
    const gate = new ConnectionRpcGate()
    gate.submit(() => new Promise<void>(() => {}))
    await expect(gate.shutdown(20)).resolves.toBe("timedOut")
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
