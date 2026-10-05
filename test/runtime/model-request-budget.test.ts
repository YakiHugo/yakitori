import { describe, expect, it } from "vitest"
import type { ModelRequest } from "../../src/runtime/model.ts"
import {
  estimateHistoryTokens,
  estimateModelRequestBudget,
} from "../../src/runtime/model-request-budget.ts"

describe("complete model request budgeting", () => {
  it("estimates newly added images without counting their base64 transport bytes", () => {
    const message = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "inspect" },
        {
          type: "image" as const,
          mediaType: "image/png" as const,
          data: "AAAA",
        },
      ],
    }
    const largeTransport = {
      ...message,
      content: message.content.map((block) =>
        block.type === "image"
          ? {
              ...block,
              data: "AAAA".repeat(100_000),
            }
          : block,
      ),
    }
    expect(estimateHistoryTokens([message])).toBeGreaterThanOrEqual(2_000)
    expect(estimateHistoryTokens([largeTransport])).toBe(
      estimateHistoryTokens([message]),
    )
  })
  it("counts system, tools, output reserve, and detail-aware images", () => {
    const high = estimateModelRequestBudget({
      ...requestWithImage("high"),
      target: {
        ...requestWithImage("high").target,
        provider: "openai",
        model: "gpt-6-sol",
      },
    })
    const original = estimateModelRequestBudget({
      ...requestWithImage("original"),
      target: {
        ...requestWithImage("original").target,
        provider: "openai",
        model: "gpt-6-sol",
      },
    })

    expect(high.envelopeTokens).toBeGreaterThan(0)
    expect(high.systemTokens).toBeGreaterThan(0)
    expect(high.messageTokens).toBeGreaterThan(0)
    expect(high.toolTokens).toBeGreaterThan(0)
    const expandedSystem = estimateModelRequestBudget({
      ...requestWithImage("high"),
      system: [
        { id: "base", revision: "2", text: "more instructions ".repeat(500) },
      ],
    })
    expect(expandedSystem.systemTokens).toBeGreaterThan(high.systemTokens)
    expect(high.imageTokens).toBe(2_000)
    expect(original.imageTokens).toBe(10_000)
    expect(original.outputReserveTokens).toBe(4_096)
    expect(original.requiredContextTokens).toBe(
      original.estimatedInputTokens + 4_096,
    )
  })

  it("does not invent an output parameter reserve for the Codex transport", () => {
    const budget = estimateModelRequestBudget(requestWithImage("high"))
    expect(budget.outputReserveTokens).toBe(0)
    expect(budget.requiredContextTokens).toBe(budget.estimatedInputTokens)
  })

  it.each([
    "openai",
    "grok",
    "codex",
    "faux",
  ])("does not reserve an unspecified server output budget for %s", (provider) => {
    const base = { ...requestWithImage("high") }
    delete base.maxOutputTokens
    const budget = estimateModelRequestBudget({
      ...base,
      target: { ...base.target, provider },
    })
    expect(budget.outputReserveTokens).toBe(0)
    expect(budget.requiredContextTokens).toBe(budget.estimatedInputTokens)
  })

  it.each([
    "anthropic",
    "kimi",
  ])("reserves the required Messages application budget and respects an explicit override for %s", (provider) => {
    const base = requestWithImage("high")
    const request = {
      ...base,
      target: { ...base.target, provider },
    }
    const fallbackRequest = { ...request }
    delete fallbackRequest.maxOutputTokens
    const fallback = estimateModelRequestBudget(fallbackRequest)
    expect(fallback.outputReserveTokens).toBe(32_000)
    expect(fallback.requiredContextTokens).toBe(
      fallback.estimatedInputTokens + 32_000,
    )
    const configured = estimateModelRequestBudget(request)
    expect(configured.outputReserveTokens).toBe(4_096)
    expect(configured.requiredContextTokens).toBe(
      configured.estimatedInputTokens + 4_096,
    )
  })

  it("does not charge native deferred definitions to the initial prompt", () => {
    const nativeRequest: ModelRequest = {
      ...requestWithImage("high"),
      toolWireProtocol: "openai_deferred",
      tools: [
        {
          name: "tool_search",
          description: "Search tools",
          inputSchema: { type: "object" },
          kind: "tool_search",
        },
        {
          name: "calendar__search_events",
          description: "A deliberately long deferred calendar definition",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
          deferLoading: true,
        },
      ],
    }
    const compatibleRequest: ModelRequest = {
      ...nativeRequest,
      target: { ...nativeRequest.target, provider: "xai" },
      toolWireProtocol: "eager",
    }

    const withoutDeferred = estimateModelRequestBudget({
      ...nativeRequest,
      tools: nativeRequest.tools.slice(0, 1),
    })
    const largerDeferred = estimateModelRequestBudget({
      ...nativeRequest,
      tools: nativeRequest.tools.map((tool) =>
        tool.deferLoading
          ? {
              ...tool,
              description: "expanded deferred definition ".repeat(500),
            }
          : tool,
      ),
    })
    expect(estimateModelRequestBudget(nativeRequest).toolTokens).toBe(
      withoutDeferred.toolTokens,
    )
    expect(largerDeferred.toolTokens).toBe(withoutDeferred.toolTokens)
    expect(
      estimateModelRequestBudget(compatibleRequest).toolTokens,
    ).toBeGreaterThan(estimateModelRequestBudget(nativeRequest).toolTokens)
  })
})

function requestWithImage(detail: "high" | "original"): ModelRequest {
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(6_400, 16)
  png.writeUInt32BE(3_200, 20)
  return {
    target: {
      provider: "codex",
      model: "gpt-5.6-sol",
      instructionProfileId: "codex",
    },
    system: [{ id: "base", revision: "1", text: "base instructions" }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "image",
            mediaType: "image/png",
            detail,
            data: png.toString("base64"),
          },
        ],
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
    maxOutputTokens: 4_096,
    toolWireProtocol: "openai_deferred",
  }
}
