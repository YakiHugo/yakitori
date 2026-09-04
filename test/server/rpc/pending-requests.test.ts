import { describe, expect, it } from "vitest"
import { INTERNAL_ERROR } from "../../../src/server/rpc/messages.ts"
import {
  isTurnTransitionRejection,
  PendingServerRequests,
  ServerRequestNotDeliveredError,
  ServerRequestRejectedError,
  TURN_TRANSITION_PENDING_REQUEST_REASON,
} from "../../../src/server/rpc/pending-requests.ts"

describe("PendingServerRequests", () => {
  it("settles the response when a client answers by process-global id", async () => {
    const pending = new PendingServerRequests()
    const first = pending.register({
      sessionId: "s1",
      method: "permission/request",
    })
    const second = pending.register({
      sessionId: "s1",
      method: "input/request",
    })
    expect(first.id).toBe(0)
    expect(second.id).toBe(1)

    expect(pending.resolve(first.id, { approved: true })).toBe(true)
    await expect(first.response).resolves.toEqual({ approved: true })
    // The entry is consumed: a repeated or unknown answer finds nothing.
    expect(pending.resolve(first.id, null)).toBe(false)
    expect(pending.resolve(999, null)).toBe(false)

    expect(
      pending.reject(second.id, {
        code: INTERNAL_ERROR,
        message: "denied",
        data: { by: "user" },
      }),
    ).toBe(true)
    const error = await rejectionOf(second.response)
    if (!(error instanceof ServerRequestRejectedError)) {
      throw new Error("expected a ServerRequestRejectedError")
    }
    expect(error.code).toBe(INTERNAL_ERROR)
    expect(error.message).toBe("denied")
    expect(error.data).toEqual({ by: "user" })
  })

  it("lists only the session's unanswered requests for replay", () => {
    const pending = new PendingServerRequests()
    const first = pending.register({
      sessionId: "s1",
      method: "permission/request",
      params: { tool: "shell" },
    })
    pending.register({ sessionId: "s2", method: "input/request" })
    const third = pending.register({
      sessionId: "s1",
      method: "permission/request",
    })
    pending.resolve(third.id, "answered")

    expect(pending.pendingForSession("s1")).toEqual([
      { id: first.id, method: "permission/request", params: { tool: "shell" } },
    ])
    expect(pending.pendingForSession("s2")).toEqual([
      { id: 1, method: "input/request" },
    ])
  })

  it("cancelForSession rejects only that session's requests", async () => {
    const pending = new PendingServerRequests()
    const cancelled = pending.register({ sessionId: "s1", method: "m" })
    const surviving = pending.register({ sessionId: "s2", method: "m" })

    pending.cancelForSession("s1", "session closed")

    const error = await rejectionOf(cancelled.response)
    if (!(error instanceof ServerRequestRejectedError)) {
      throw new Error("expected a ServerRequestRejectedError")
    }
    expect(error.message).toBe("session closed")
    expect(isTurnTransitionRejection(error)).toBe(false)
    expect(pending.pendingForSession("s1")).toEqual([])

    expect(pending.resolve(surviving.id, "still answerable")).toBe(true)
    await expect(surviving.response).resolves.toBe("still answerable")
  })

  it("cancelAll rejects every pending request", async () => {
    const pending = new PendingServerRequests()
    const first = pending.register({ sessionId: "s1", method: "m" })
    const second = pending.register({ sessionId: "s2", method: "m" })

    pending.cancelAll("server shutting down")

    for (const registered of [first, second]) {
      const error = await rejectionOf(registered.response)
      if (!(error instanceof ServerRequestRejectedError)) {
        throw new Error("expected a ServerRequestRejectedError")
      }
      expect(error.message).toBe("server shutting down")
    }
  })

  it("abortForTurnTransition rejects with a marker distinguishable from a denial", async () => {
    const pending = new PendingServerRequests()
    const aborted = pending.register({
      sessionId: "s1",
      method: "permission/request",
    })
    const denied = pending.register({
      sessionId: "s2",
      method: "permission/request",
    })

    pending.abortForTurnTransition("s1")
    pending.reject(denied.id, { code: INTERNAL_ERROR, message: "denied" })

    const abortError = await rejectionOf(aborted.response)
    expect(isTurnTransitionRejection(abortError)).toBe(true)
    if (!(abortError instanceof ServerRequestRejectedError)) {
      throw new Error("expected a ServerRequestRejectedError")
    }
    expect(abortError.code).toBe(INTERNAL_ERROR)
    expect(abortError.data).toEqual({
      reason: TURN_TRANSITION_PENDING_REQUEST_REASON,
    })

    const denialError = await rejectionOf(denied.response)
    expect(isTurnTransitionRejection(denialError)).toBe(false)
    expect(isTurnTransitionRejection(new Error("unrelated"))).toBe(false)
  })

  it("drop rejects an undelivered request and is a no-op once settled", async () => {
    const pending = new PendingServerRequests()
    const undelivered = pending.register({ sessionId: "s1", method: "m" })
    undelivered.drop()
    const error = await rejectionOf(undelivered.response)
    expect(error).toBeInstanceOf(ServerRequestNotDeliveredError)
    // Already dropped: a repeated drop must not throw or re-settle.
    undelivered.drop()

    const delivered = pending.register({ sessionId: "s1", method: "m" })
    expect(pending.resolve(delivered.id, "ok")).toBe(true)
    delivered.drop()
    await expect(delivered.response).resolves.toBe("ok")
  })
})

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the response to reject")
    },
    (reason: unknown) => reason,
  )
}
