import { describe, expect, it } from "vitest"
import type { ModelRequest } from "../../src/runtime/model.ts"
import {
  createModelUsageBaseline,
  effectiveRequestInputTokens,
  estimateModelRequestBudget,
} from "../../src/runtime/model-request-budget.ts"

describe("complete model request budgeting", () => {
  it("counts system, tools, output reserve, and detail-aware images", () => {
    const high = estimateModelRequestBudget(requestWithImage("high"))
    const original = estimateModelRequestBudget(requestWithImage("original"))

    expect(high.envelopeTokens).toBeGreaterThan(0)
    expect(high.systemTokens).toBeGreaterThan(0)
    expect(high.messageTokens).toBeGreaterThan(0)
    expect(high.toolTokens).toBeGreaterThan(0)
    expect(high.imageTokens).toBe(1_844)
    expect(original.imageTokens).toBe(10_000)
    expect(original.outputReserveTokens).toBe(4_096)
    expect(original.requiredContextTokens).toBe(
      original.estimatedInputTokens + 4_096,
    )
  })

  it("uses provider input usage plus only the estimated request delta", () => {
    const firstRequest = requestWithImage("high")
    const firstBudget = estimateModelRequestBudget(firstRequest)
    const baseline = createModelUsageBaseline({
      request: firstRequest,
      contextWindowId: "window_1",
      budget: firstBudget,
      usage: { inputTokens: firstBudget.estimatedInputTokens + 500 },
    })
    if (baseline === undefined) throw new Error("missing baseline")
    const nextRequest = {
      ...firstRequest,
      messages: [
        ...firstRequest.messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "next" }],
        },
      ],
    }
    const nextBudget = estimateModelRequestBudget(nextRequest)

    expect(
      effectiveRequestInputTokens({
        request: nextRequest,
        contextWindowId: "window_1",
        budget: nextBudget,
        baseline,
      }),
    ).toBe(
      baseline.providerInputTokens +
        nextBudget.estimatedInputTokens -
        firstBudget.estimatedInputTokens,
    )
    expect(
      effectiveRequestInputTokens({
        request: nextRequest,
        contextWindowId: "window_2",
        budget: nextBudget,
        baseline,
      }),
    ).toBe(nextBudget.estimatedInputTokens)

    const replacedPrefixRequest = {
      ...nextRequest,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "replacement prefix" }],
        },
        ...nextRequest.messages.slice(1),
      ],
    }
    const replacedPrefixBudget = estimateModelRequestBudget(
      replacedPrefixRequest,
    )
    expect(
      effectiveRequestInputTokens({
        request: replacedPrefixRequest,
        contextWindowId: "window_1",
        budget: replacedPrefixBudget,
        baseline,
      }),
    ).toBe(replacedPrefixBudget.estimatedInputTokens)
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
  }
}
