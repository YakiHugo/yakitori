import { describe, expect, it } from "vitest"
import {
  ComputerControl,
  type ComputerUseOwner,
} from "../../src/server/computer-control.ts"

function lease(sessionId: string) {
  const interrupted = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let cancellations = 0
  const owner: ComputerUseOwner = {
    sessionId,
    turnId: `turn_${sessionId}`,
    released: released.promise,
    async interrupt() {
      cancellations++
      interrupted.resolve()
    },
  }
  return {
    owner,
    interrupted: interrupted.promise,
    released,
    cancellations: () => cancellations,
  }
}

describe("computer input ownership", () => {
  it("disconnect seals new calls from the current lease without interrupting its in-flight input", async () => {
    const control = new ComputerControl()
    const current = lease("current")
    control.acquire(current.owner)
    control.disconnect()
    expect(control.admissionPaused).toBe(true)
    expect(control.takenOver).toBe(false)
    expect(control.acquire(current.owner)).toBe("computer_disconnected")
    expect(control.acquire(lease("other").owner)).toBe("computer_disconnected")
    expect(current.cancellations()).toBe(0)
    expect(control.owner).toBe(current.owner)
    control.release(current.owner)
    control.resume(control.prepareResume())
    expect(control.acquire(current.owner)).toBeUndefined()
  })

  it("still interrupts and joins native release when persisting disconnection fails", async () => {
    const control = new ComputerControl()
    const current = lease("config_failure")
    control.acquire(current.owner)
    const failure = new Error("Configuration changed concurrently")
    const stopping = control.takeOver(() => {
      throw failure
    })
    await current.interrupted
    expect(current.cancellations()).toBe(1)
    control.release(current.owner)
    current.released.resolve()
    await expect(stopping).rejects.toBe(failure)
    expect(control.acquire(lease("later").owner)).toBe("computer_taken_over")
  })

  it("waits for disconnection without an owner and refuses a connect started before takeover", async () => {
    const control = new ComputerControl()
    const epoch = control.prepareResume()
    const disconnected = Promise.withResolvers<void>()
    const stopping = control.takeOver(() => disconnected.promise)
    expect(() => control.prepareResume()).toThrow("resource cleanup")
    disconnected.resolve()
    await stopping
    expect(() => control.resume(epoch)).toThrow(
      "while computer use was connecting",
    )
    const current = lease("after_takeover")
    expect(control.acquire(current.owner)).toBe("computer_taken_over")
    control.resume(control.prepareResume())
    expect(control.acquire(current.owner)).toBeUndefined()
  })

  it("seals new admission before cancellation and waits for native release", async () => {
    const control = new ComputerControl()
    const current = lease("first"),
      other = lease("other")
    expect(control.acquire(current.owner)).toBeUndefined()
    expect(control.acquire(other.owner)).toBe("computer_busy")
    let completed = false
    const stopped = control.takeOver().then(() => {
      completed = true
    })
    const repeated = control.takeOver()
    expect(control.acquire(current.owner)).toBe("computer_taken_over")
    expect(control.acquire(other.owner)).toBe("computer_taken_over")
    await current.interrupted
    expect(completed).toBe(false)
    expect(current.cancellations()).toBe(1)
    expect(() => control.resume(control.prepareResume())).toThrow(
      "resource cleanup",
    )
    control.release(other.owner)
    expect(control.owner).toBe(current.owner)
    control.release(current.owner)
    current.released.resolve()
    await Promise.all([stopped, repeated])
    expect(control.acquire(other.owner)).toBe("computer_taken_over")
    control.resume(control.prepareResume())
    expect(control.acquire(other.owner)).toBeUndefined()
  })

  it("keeps failed cleanup occupied until the owning session closes its connection", async () => {
    const control = new ComputerControl()
    const current = lease("failed"),
      other = lease("other")
    control.acquire(current.owner)
    const stopping = control.takeOver()
    const error = new Error("native release failed")
    current.released.reject(error)
    await expect(stopping).rejects.toBe(error)
    control.releaseSession("other")
    expect(() => control.resume(control.prepareResume())).toThrow(
      "resource cleanup",
    )
    expect(control.acquire(other.owner)).toBe("computer_taken_over")
    control.releaseSession("failed")
    control.resume(control.prepareResume())
    expect(control.acquire(other.owner)).toBeUndefined()
  })

  it("blocks further input after uncertain cleanup until the owning resource is released", () => {
    const control = new ComputerControl(),
      first = lease("first"),
      other = lease("other")
    control.acquire(first.owner)
    control.markCleanupPending(other.owner)
    expect(control.acquire(first.owner)).toBeUndefined()
    control.markCleanupPending(first.owner)
    expect(control.acquire(first.owner)).toBe("computer_cleanup_pending")
    expect(control.acquire(other.owner)).toBe("computer_cleanup_pending")
    control.releaseSession("other")
    expect(control.acquire(first.owner)).toBe("computer_cleanup_pending")
    control.release(first.owner)
    expect(control.acquire(other.owner)).toBeUndefined()
  })
})
