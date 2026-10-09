import { describe, expect, it } from "vitest"
import { modelFailureFromUnknown } from "../../src/runtime/model-failure.ts"

const input = {
  provider: "kimi",
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
})
