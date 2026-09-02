import { describe, expect, it } from "vitest"
import { createRequestGate } from "../../src/server/request-gate.ts"

describe("request gate", () => {
  it("lets admitted work finish and never polls work submitted after close", async () => {
    const gate = createRequestGate()
    const release = deferred<void>()
    let lateOperationPolled = false
    const admitted = gate.run(async () => {
      await release.promise
      return "finished"
    })

    gate.close()
    const late = gate.run(async () => {
      lateOperationPolled = true
      return "late"
    })

    expect(gate.accepting).toBe(false)
    expect(gate.inFlightCount).toBe(1)
    await expect(late).resolves.toEqual({ accepted: false })
    expect(lateOperationPolled).toBe(false)

    let drained = false
    const shutdown = gate.shutdown().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    release.resolve()
    await expect(admitted).resolves.toEqual({
      accepted: true,
      value: "finished",
    })
    await shutdown
    expect(drained).toBe(true)
    expect(gate.inFlightCount).toBe(0)
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
