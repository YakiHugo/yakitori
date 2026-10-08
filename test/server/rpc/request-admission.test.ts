import { describe, expect, it } from "vitest"
import { createRequestGate } from "../../../src/server/request-gate.ts"
import { MessageProcessor } from "../../../src/server/rpc/message-processor.ts"
import {
  createFakeHandlers,
  initializeConnection,
  openTestConnection,
} from "./testkit.ts"

describe("process-wide RPC admission", () => {
  it("rejects new handlers after process admission closes but still accepts pending server answers", async () => {
    const requestGate = createRequestGate()
    let reads = 0
    const base = createFakeHandlers()
    const processor = new MessageProcessor({
      requestGate,
      handlers: {
        ...base,
        async listSessions(input) {
          reads += 1
          return base.listSessions(input)
        },
      },
    })
    const connection = openTestConnection(processor)
    await initializeConnection(connection)
    const pending = processor.pendingServerRequests.register({
      sessionId: "session_1",
      method: "session/permission/request",
    })
    requestGate.close()
    try {
      await expect(
        connection.sendRequest("session/list", {}),
      ).resolves.toMatchObject({
        error: { message: "Server is shutting down." },
      })
      expect(reads).toBe(0)
      connection.sendRaw(
        JSON.stringify({ id: pending.id, result: { behavior: "allow" } }),
      )
      await expect(pending.response).resolves.toEqual({ behavior: "allow" })
      expect(requestGate.inFlightCount).toBe(0)
    } finally {
      await processor.closeConnection(connection.id)
    }
  })
})
