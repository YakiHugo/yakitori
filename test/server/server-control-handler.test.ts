import { describe, expect, it } from "vitest"
import type { ServerControlResponse } from "../../src/desktop/server-control.ts"
import { createRequestGate } from "../../src/server/request-gate.ts"
import { createServerControlMessageHandler } from "../../src/server/server-control-handler.ts"

describe("server control message handler", () => {
  it("holds its gate token until the response send is acknowledged", async () => {
    const gate = createRequestGate()
    const sendStarted = deferred<void>()
    const releaseSend = deferred<void>()
    const responses: ServerControlResponse[] = []
    const onMessage = createServerControlMessageHandler({
      requestGate: gate,
      handleRequest: async (request) => ({
        requestId: request.requestId,
        ok: true,
      }),
      async sendResponse(response) {
        responses.push(response)
        sendStarted.resolve()
        await releaseSend.promise
      },
      reportOperationalFailure: () => {},
    })

    onMessage({
      type: "discard_draft_images",
      requestId: "request_1",
      attachments: [],
    })
    await sendStarted.promise
    gate.close()
    let drained = false
    const shutdown = gate.shutdown().then(() => {
      drained = true
    })
    await Promise.resolve()

    expect(drained).toBe(false)
    expect(responses).toEqual([{ requestId: "request_1", ok: true }])

    releaseSend.resolve()
    await shutdown
    expect(drained).toBe(true)
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
