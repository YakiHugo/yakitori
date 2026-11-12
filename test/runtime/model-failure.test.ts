import { describe, expect, it } from "vitest"
import {
  modelFailureFromUnknown,
  providerErrorMessage,
} from "../../src/runtime/model-failure.ts"

const input = {
  provider: "kimi-code",
  wireApi: "anthropic_messages" as const,
  stage: "connect" as const,
  kind: "invalid_request" as const,
  status: 400,
  providerCode: "invalid_request_error",
  fallbackMessage: "Request failed.",
}

describe("model failure diagnostics", () => {
  it("keeps a bounded explicit provider reason and transport diagnostics", () => {
    const failure = modelFailureFromUnknown(
      Object.assign(new Error("unselected body"), { code: "ECONNRESET" }),
      {
        ...input,
        providerMessage: `  Missing tool_result. ${"x".repeat(3_000)}  `,
      },
    )
    expect(failure.kind).toBe("invalid_request")
    expect(failure.details?.providerMessage).toHaveLength(2_000)
    expect(failure.details?.causeCode).toBe("ECONNRESET")
    expect(failure.message).toContain("HTTP 400, invalid_request_error")
    expect(failure.message).toContain("Missing tool_result.")
    expect(failure.message).not.toContain("unselected body")
  })

  it.each([
    undefined,
    "",
    "   ",
  ])("does not serialize arbitrary errors when the provider reason is %j", (providerMessage) => {
    const failure = modelFailureFromUnknown(
      new Error('400 {"authorization":"secret","body":"private prompt"}'),
      {
        ...input,
        ...(providerMessage === undefined ? {} : { providerMessage }),
      },
    )
    expect(failure.message).toBe("The model provider rejected the request.")
    expect(failure.details).toBeUndefined()
    expect(JSON.stringify(failure)).not.toContain("secret")
    expect(JSON.stringify(failure)).not.toContain("private prompt")
  })

  it("reads xAI string error payloads used for invalid reasoningEffort", () => {
    expect(
      providerErrorMessage({
        code: "invalid-argument",
        error:
          "Model grok-4.20-0309-non-reasoning does not support parameter reasoningEffort.",
      }),
    ).toBe(
      "Model grok-4.20-0309-non-reasoning does not support parameter reasoningEffort.",
    )
    expect(
      providerErrorMessage({
        error: {
          message: "OpenAI-shaped reason",
          type: "invalid_request_error",
        },
      }),
    ).toBe("OpenAI-shaped reason")
  })

  it.each([
    "UND_ERR_INVALID_ARG",
    "UND_ERR_CLOSED",
    "UND_ERR_DESTROYED",
    "ERR_INVALID_URL",
    "ERR_INVALID_ARG_VALUE",
    "CERT_HAS_EXPIRED",
  ])("makes wrapped local transport error %s terminal despite the adapter's connection classification", (code) => {
    const failure = modelFailureFromUnknown(
      Object.assign(
        new Error("Connection error.", {
          cause: new TypeError("fetch failed", {
            cause: Object.assign(new Error("unselected private argument"), {
              code,
            }),
          }),
        }),
        { code: "SDK_CONNECTION_ERROR" },
      ),
      {
        provider: "test",
        wireApi: "openai_responses",
        stage: "connect",
        fallbackMessage: "Request failed.",
        kind: "connection_failed",
        serverShouldRetry: true,
      },
    )
    expect(failure).toMatchObject({
      kind: "invalid_request",
      serverShouldRetry: false,
      details: { causeCode: code },
    })
    expect(failure.message).toContain("local transport or configuration")
    expect(failure.message).not.toContain("private argument")
  })

  it.each([
    new TypeError("Invalid header value"),
    new RangeError("Invalid timeout"),
    new ReferenceError("Missing configuration"),
  ])("makes a wrapped programmer error terminal: %s", (cause) => {
    expect(
      modelFailureFromUnknown(new Error("Connection error.", { cause }), {
        provider: "test",
        wireApi: "openai_responses",
        stage: "connect",
        kind: "connection_failed",
        fallbackMessage: "Request failed.",
      }),
    ).toMatchObject({ kind: "invalid_request", serverShouldRetry: false })
  })

  it("keeps a fetch TypeError caused by a socket disconnect retryable", () => {
    expect(
      modelFailureFromUnknown(
        new TypeError("terminated", {
          cause: Object.assign(new Error("other side closed"), {
            code: "UND_ERR_SOCKET",
          }),
        }),
        {
          provider: "test",
          wireApi: "openai_responses",
          stage: "response_body",
          fallbackMessage: "Request failed.",
        },
      ),
    ).toMatchObject({
      kind: "stream_disconnected",
      details: { causeCode: "UND_ERR_SOCKET" },
    })
  })

  it("finds a socket error code beneath an SDK wrapper code without interpreting messages", () => {
    const failure = modelFailureFromUnknown(
      Object.assign(
        new Error("outer diagnostic", {
          cause: new TypeError("fetch diagnostic", {
            cause: Object.assign(new Error("socket diagnostic"), {
              code: "UND_ERR_SOCKET",
            }),
          }),
        }),
        { code: "SDK_CONNECTION_ERROR" },
      ),
      {
        provider: "test",
        wireApi: "openai_responses",
        stage: "response_body",
        fallbackMessage: "Request failed.",
      },
    )
    expect(failure).toMatchObject({
      kind: "stream_disconnected",
      details: { causeCode: "UND_ERR_SOCKET" },
    })
  })

  it.each([
    "terminated",
    "socket hang up",
    "connection closed",
    "connection reset",
    "other side closed",
  ])("does not infer a transport failure from the diagnostic %j", (message) => {
    expect(
      modelFailureFromUnknown(new Error(message), {
        provider: "test",
        wireApi: "openai_responses",
        stage: "response_body",
        fallbackMessage: "Request failed.",
      }),
    ).toMatchObject({ kind: "provider_error", message: "Request failed." })
  })
})
