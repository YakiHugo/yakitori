import { describe, expect, it } from "vitest"
import {
  INVALID_REQUEST,
  JsonRpcParseError,
  type JsonRpcMessage,
  PARSE_ERROR,
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
} from "../../../src/server/rpc/messages.ts"

describe("parseJsonRpcMessage", () => {
  const roundtripCases: ReadonlyArray<{
    name: string
    message: JsonRpcMessage
  }> = [
    {
      name: "a request with numeric id, params, and trace",
      message: {
        id: 1,
        method: "thread/resume",
        params: { threadId: "t-1" },
        trace: { traceparent: "00-abc-01" },
      },
    },
    {
      name: "a request with string id and no params",
      message: { id: "req-2", method: "initialize" },
    },
    {
      name: "a notification with params",
      message: { method: "session/updated", params: { sessionId: "s-1" } },
    },
    {
      name: "a notification without params",
      message: { method: "server/heartbeat" },
    },
    {
      name: "a result response",
      message: { id: 7, result: { ok: true } },
    },
    {
      name: "an error response with data",
      message: {
        id: "9",
        error: { code: -32603, message: "boom", data: { detail: 1 } },
      },
    },
    {
      name: "an error response without data",
      message: { id: 3, error: { code: -32601, message: "unknown method" } },
    },
  ]

  for (const { name, message } of roundtripCases) {
    it(`roundtrips ${name}`, () => {
      const text = serializeJsonRpcMessage(message)
      expect(text).not.toContain("jsonrpc")
      expect(parseJsonRpcMessage(text)).toEqual(message)
    })
  }

  it("parses a request carrying params explicitly set to null", () => {
    expect(parseJsonRpcMessage('{"id":4,"method":"m","params":null}')).toEqual({
      id: 4,
      method: "m",
      params: null,
    })
  })

  it("classifies a frame carrying both result and error as a result response", () => {
    // Codex's untagged enum tries the Response variant before Error.
    expect(
      parseJsonRpcMessage(
        '{"id":1,"result":null,"error":{"code":-32603,"message":"x"}}',
      ),
    ).toEqual({ id: 1, result: null })
  })

  it.each([
    "not json",
    "{",
    "",
  ])("rejects malformed JSON with the parse-error code: %j", (text) => {
    const error = parseFailure(text)
    expect(error.code).toBe(PARSE_ERROR)
  })

  const invalidShapes: ReadonlyArray<{ name: string; text: string }> = [
    {
      name: "id but neither method, result, nor error",
      text: '{"id":1}',
    },
    { name: "id of wrong type", text: '{"id":true,"method":"m"}' },
    { name: "non-integer numeric id", text: '{"id":1.5,"method":"m"}' },
    { name: "null id", text: '{"id":null,"result":1}' },
    { name: "method of wrong type", text: '{"id":1,"method":3}' },
    { name: "result without id", text: '{"result":1}' },
    { name: "batch array", text: '[{"id":1,"method":"m"}]' },
    { name: "non-object", text: "42" },
    {
      name: "error object with non-numeric code",
      text: '{"id":1,"error":{"code":"x","message":"m"}}',
    },
    {
      name: "error object without message",
      text: '{"id":1,"error":{"code":-32603}}',
    },
  ]

  for (const { name, text } of invalidShapes) {
    it(`rejects invalid shape with the invalid-request code: ${name}`, () => {
      const error = parseFailure(text)
      expect(error.code).toBe(INVALID_REQUEST)
    })
  }
})

function parseFailure(text: string): JsonRpcParseError {
  try {
    parseJsonRpcMessage(text)
  } catch (error) {
    if (error instanceof JsonRpcParseError) return error
    throw error
  }
  throw new Error("expected parseJsonRpcMessage to throw")
}
