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
      content: [{ type: "text" as const, text: "inspect" }],
      images: [
        {
          type: "image" as const,
          mediaType: "image/png" as const,
          data: "AAAA",
        },
      ],
    }
    const largeTransport = {
      ...message,
      images: message.images.map((image) => ({
        ...image,
        data: "AAAA".repeat(100_000),
      })),
    }
    expect(estimateHistoryTokens([message])).toBeGreaterThanOrEqual(2_000)
    expect(estimateHistoryTokens([largeTransport])).toBe(
      estimateHistoryTokens([message]),
    )
  })
  it("counts system, tools, output reserve, and detail-aware images", () => {
    const high = estimateModelRequestBudget(requestWithImage("high"))
    const original = estimateModelRequestBudget(requestWithImage("original"))

    expect(high.envelopeTokens).toBeGreaterThan(0)
    expect(high.systemTokens).toBeGreaterThan(0)
    expect(high.messageTokens).toBeGreaterThan(0)
    expect(high.toolTokens).toBeGreaterThan(0)
    expect(high.systemTokens).toBe(
      Math.ceil(
        Buffer.byteLength(JSON.stringify(requestWithImage("high").system)) / 4,
      ),
    )
    expect(high.imageTokens).toBe(2_000)
    expect(original.imageTokens).toBe(10_000)
    expect(original.outputReserveTokens).toBe(4_096)
    expect(original.requiredContextTokens).toBe(
      original.estimatedInputTokens + 4_096,
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

    expect(estimateModelRequestBudget(nativeRequest).toolTokens).toBe(
      Math.ceil(
        Buffer.byteLength(JSON.stringify(nativeRequest.tools.slice(0, 1))) / 4,
      ),
    )
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
        content: [{ type: "text", text: "inspect" }],
        images: [
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
