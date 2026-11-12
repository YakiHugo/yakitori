import { describe, expect, it } from "vitest"
import { isContextOverflowError } from "../../src/runtime/compaction.ts"
import { ModelFailureError } from "../../src/runtime/errors.ts"
import type { ModelFailure } from "../../src/runtime/model.ts"
import { modelFailureFromUnknown } from "../../src/runtime/model-failure.ts"

function failure(overrides: Partial<ModelFailure> = {}): ModelFailureError {
  return new ModelFailureError({
    kind: "invalid_request",
    stage: "response_headers",
    provider: "test",
    wireApi: "unknown",
    message: "The provider rejected the request.",
    ...overrides,
  })
}

describe("context overflow error evidence", () => {
  it.each([
    "context_length_exceeded",
    "context_window_exceeded",
    "prompt_too_long",
  ])("accepts structured %s without matching prose or HTTP status", (providerCode) => {
    expect(
      isContextOverflowError(
        failure({
          kind: "provider_error",
          stage: "model_event",
          providerCode,
        }),
      ),
    ).toBe(true)
  })

  it("accepts an actual HTTP 413 without matching prose", () => {
    expect(isContextOverflowError(failure({ status: 413 }))).toBe(true)
  })

  it.each([
    undefined,
    400,
    422,
  ])("accepts a genuine long-prompt rejection with status %s", (status) => {
    expect(
      isContextOverflowError(
        failure({
          ...(status === undefined ? {} : { status }),
          providerCode: "invalid_request_error",
          message: "prompt is too long: 250000 tokens > 200000 maximum",
        }),
      ),
    ).toBe(true)
  })

  it.each([
    "HTTP 413",
    "Unknown model deployment-413",
    "Invalid request (request ID: req_413abcdef)",
    "Cannot read file at line 413",
    "Invalid context length setting",
    "Unknown field context_length",
    "The response omitted context window metadata",
  ])("does not infer overflow from incidental text: %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(false)
    expect(isContextOverflowError(failure({ status: 400, message }))).toBe(
      false,
    )
  })

  it.each([
    "authentication",
    "connection_failed",
    "idle_timeout",
    "protocol_error",
    "rate_limited",
    "server_error",
    "stream_disconnected",
  ] as const)("does not override structured %s with overflow prose", (kind) => {
    expect(
      isContextOverflowError(
        failure({ kind, message: "The prompt is too long." }),
      ),
    ).toBe(false)
  })

  it.each([
    401, 402, 403, 404, 408, 429, 500, 503,
  ])("does not override HTTP %s with overflow prose", (status) => {
    expect(
      isContextOverflowError(
        failure({ status, message: "Too many tokens; try again later." }),
      ),
    ).toBe(false)
  })

  it.each([
    "credit_balance_exhausted",
    "insufficient_quota",
    "usage_limit_reached",
    "authentication_error",
    "permission_error",
    "rate_limit_error",
    "rate_limit_exceeded",
    "server_error",
    "server_overloaded",
    "overloaded_error",
  ])("does not override structured %s with overflow prose", (providerCode) => {
    expect(
      isContextOverflowError(
        failure({
          kind: "provider_error",
          providerCode,
          message: "Too many tokens; prompt is too long.",
        }),
      ),
    ).toBe(false)
  })

  it("does not classify local request construction as overflow", () => {
    expect(
      isContextOverflowError(
        failure({
          stage: "request_build",
          message: "The prompt is too long for the configured local resource.",
        }),
      ),
    ).toBe(false)
  })

  it("does not classify a normalized local transport error as overflow", () => {
    const error = Object.assign(new TypeError("prompt is too long"), {
      code: "ERR_INVALID_URL",
    })
    expect(
      isContextOverflowError(
        new ModelFailureError(
          modelFailureFromUnknown(error, {
            provider: "test",
            wireApi: "unknown",
            stage: "connect",
            fallbackMessage: "Request failed.",
            providerMessage: error.message,
          }),
        ),
      ),
    ).toBe(false)
  })

  it("allows a provider rejection with a diagnostic cause code", () => {
    expect(
      isContextOverflowError(
        failure({
          status: 400,
          providerCode: "invalid_request_error",
          details: { causeCode: "invalid_request_error" },
          message: "prompt is too long",
        }),
      ),
    ).toBe(true)
  })
})
