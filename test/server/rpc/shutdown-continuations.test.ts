import { describe, expect, it } from "vitest"
import { createRequestGate } from "../../../src/server/request-gate.ts"
import {
  MessageProcessor,
  type MessageProcessorOptions,
} from "../../../src/server/rpc/message-processor.ts"
import { rpcMethods } from "../../../src/server/rpc/methods.ts"
import { createElicitationBroker } from "../../../src/server/user-interactions.ts"
import {
  createFakeHandlers,
  initializeConnection,
  openTestConnection,
} from "./testkit.ts"

async function fixture(overrides: Partial<MessageProcessorOptions> = {}) {
  const requestGate = createRequestGate()
  const processor = new MessageProcessor({
    handlers: createFakeHandlers(),
    requestGate,
    ...overrides,
  })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  return {
    requestGate,
    processor,
    connection,
    close: () => processor.closeConnection(connection.id),
  }
}

describe("existing-work controls during process drain", () => {
  it("classifies only connection and existing-work continuations", () => {
    expect(
      rpcMethods
        .filter((entry) => entry.shutdownContinuation)
        .map((entry) => entry.method)
        .sort(),
    ).toEqual([
      "engineSession/cancel",
      "engineSession/respondPermission",
      "server/ping",
      "session/elicitation/answer",
      "session/elicitation/list",
      "session/subscribe",
      "session/turn/cancel",
      "session/unsubscribe",
      "sideChat/cancel",
      "sideChat/close",
      "sideChat/resolvePermission",
    ])
  })

  it("keeps heartbeat, the session view and Stop available on an existing connection", async () => {
    const f = await fixture()
    try {
      await f.connection.sendRequest("session/subscribe", {
        sessionId: "session_1",
        after: 0,
      })
      f.requestGate.close()
      for (const [method, params] of [
        ["server/ping", {}],
        ["session/unsubscribe", { sessionId: "session_1" }],
        ["session/subscribe", { sessionId: "session_1", after: 0 }],
        ["session/turn/cancel", { sessionId: "session_1", turnId: "turn_1" }],
      ] as const) {
        expect(await f.connection.sendRequest(method, params)).toHaveProperty(
          "result",
        )
      }
    } finally {
      await f.close()
    }
  })

  it("answers a pending elicitation without admitting another Turn", async () => {
    const elicitations = createElicitationBroker()
    let questions = 0
    let inputs = 0
    const f = await fixture({
      handlers: createFakeHandlers({
        async admitInput() {
          inputs += 1
          throw new Error("Unexpected new input")
        },
      }),
      interactions: {
        elicitations,
        async answer() {
          questions += 1
          throw new Error("Unexpected new question Turn")
        },
      },
    })
    const controller = new AbortController()
    const pending = elicitations.request(
      "session_1",
      "fixture",
      {
        mode: "form",
        message: "Choose",
        requestedSchema: { type: "object", properties: {} },
      },
      controller.signal,
    )
    try {
      const request = elicitations.list("session_1")[0]
      if (!request) throw new Error("Missing pending elicitation")
      f.requestGate.close()
      expect(
        await f.connection.sendRequest("session/elicitation/list", {
          sessionId: "session_1",
        }),
      ).toMatchObject({ result: { requests: [request] } })
      expect(
        await f.connection.sendRequest("session/elicitation/answer", {
          sessionId: "session_1",
          requestId: request.requestId,
          result: { action: "accept", content: {} },
        }),
      ).toMatchObject({ result: {} })
      await expect(pending).resolves.toEqual({ action: "accept", content: {} })
      for (const [method, params] of [
        [
          "session/question/answer",
          { sessionId: "session_1", toolCallId: "question", answers: ["a"] },
        ],
        ["session/input", {}],
        ["session/list", {}],
      ] as const) {
        expect(await f.connection.sendRequest(method, params)).toMatchObject({
          error: { message: "Server is shutting down." },
        })
      }
      expect(questions).toBe(0)
      expect(inputs).toBe(0)
    } finally {
      controller.abort()
      await pending
      await f.close()
    }
  })
})
