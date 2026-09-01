import { describe, expect, it } from "vitest"
import { createToolExecutionGate } from "../../src/runtime/tool-execution-gate.ts"

describe("tool execution gate", () => {
  it("runs readers together, gives an earlier writer its barrier, then resumes readers together", async () => {
    const gate = createToolExecutionGate()
    const releaseReaders = deferred<void>()
    const releaseWriter = deferred<void>()
    const enteredReaders = deferred<void>()
    const enteredWriter = deferred<void>()
    const enteredLaterReaders = deferred<void>()
    const releaseLaterReaders = deferred<void>()
    const events: string[] = []
    let readerCount = 0
    let laterReaderCount = 0

    const reader = (name: string, later = false) =>
      gate.run(true, undefined, async () => {
        events.push(`start:${name}`)
        if (later) {
          laterReaderCount += 1
          if (laterReaderCount === 2) enteredLaterReaders.resolve()
          await releaseLaterReaders.promise
        } else {
          readerCount += 1
          if (readerCount === 2) enteredReaders.resolve()
          await releaseReaders.promise
        }
        events.push(`end:${name}`)
      })

    const first = reader("a")
    const second = reader("b")
    await enteredReaders.promise
    const writer = gate.run(false, undefined, async () => {
      events.push("start:write")
      enteredWriter.resolve()
      await releaseWriter.promise
      events.push("end:write")
    })
    const fourth = reader("d", true)
    const fifth = reader("e", true)

    await Promise.resolve()
    expect(events).toEqual(["start:a", "start:b"])
    releaseReaders.resolve()
    await enteredWriter.promise
    expect(events).toEqual([
      "start:a",
      "start:b",
      "end:a",
      "end:b",
      "start:write",
    ])
    releaseWriter.resolve()
    await enteredLaterReaders.promise
    expect(events.slice(5, 8)).toEqual(["end:write", "start:d", "start:e"])
    releaseLaterReaders.resolve()
    await Promise.all([first, second, writer, fourth, fifth])
  })

  it("removes an aborted waiter without blocking the queue", async () => {
    const gate = createToolExecutionGate()
    const releaseWriter = deferred<void>()
    const writerEntered = deferred<void>()
    const writer = gate.run(false, undefined, async () => {
      writerEntered.resolve()
      await releaseWriter.promise
    })
    await writerEntered.promise

    const abort = new AbortController()
    const waiting = gate.run(true, abort.signal, async () => "unreachable")
    abort.abort()
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" })

    releaseWriter.resolve()
    await writer
    await expect(gate.run(true, undefined, async () => "next")).resolves.toBe(
      "next",
    )
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}
