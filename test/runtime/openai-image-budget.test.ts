import { prepareModelMedia } from "../../src/runtime/model-media.ts"
import { describe, expect, it } from "vitest"
import type {
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
} from "../../src/runtime/model.ts"
import {
  estimateHistoryTokens,
  estimateModelRequestBudget,
} from "../../src/runtime/model-request-budget.ts"
import { openAIImageTokenEstimator } from "../../src/runtime/openai-image-budget.ts"

const context = {
  serviceId: "openai",
  wireApi: "openai_responses" as const,
  model: {
    model: "gpt-5.6-sol",
    usedFallbackModelMetadata: false,
    inputModalities: ["text", "image"] as const,
    imageDetailModes: ["high", "original"] as const,
  },
}

// Header-only fixtures exercise synchronous estimation, not image admission.
function image(
  width: number,
  height: number,
  detail?: "high" | "original",
): ModelImageBlock {
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return {
    type: "image",
    mediaType: "image/png",
    data: png.toString("base64"),
    ...(detail === undefined ? {} : { detail }),
  }
}

function estimator(model = "gpt-5.6-sol") {
  const estimate = openAIImageTokenEstimator({
    ...context,
    model: { ...context.model, model },
  })
  if (estimate === undefined) throw new Error("Missing known-model estimate")
  return (image: ModelImageBlock, stage: "history" | "prepared" = "prepared") =>
    estimate(image, stage)
}

describe("native OpenAI Responses image estimates", () => {
  it.each([
    "high",
    "original",
  ] as const)("matches raw history to actual media projection when %s is downgraded/prepared", async (detail) => {
    const { default: sharp } = await import("sharp")
    const bytes = await sharp({
      create: { width: 4096, height: 512, channels: 3, background: "red" },
    })
      .png()
      .toBuffer()
    const raw: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      detail,
      data: bytes.toString("base64"),
    }
    const messages: ModelMessage[] = [{ role: "user", content: [raw] }]
    const facts = {
      ...context.model,
      model: "gpt-6-astra",
      imageDetailModes: ["high"] as const,
    }
    const estimate = openAIImageTokenEstimator({ ...context, model: facts })
    if (estimate === undefined) throw new Error("Missing known-model estimate")
    const projected = await prepareModelMedia(messages, {
      target: {
        provider: "renamed",
        model: "gpt-6-astra",
        instructionProfileId: "generic",
      },
      imageCapabilities: facts,
      rolloutAssets: undefined,
      documentReading: { nativePdf: false, images: true },
      userDocumentReading: { nativePdf: false, images: true },
    })
    const result = projected[0]
    const prepared =
      result?.role === "user"
        ? result.content.find((block) => block.type === "image")
        : undefined
    expect(prepared).toBeDefined()
    if (prepared === undefined) throw new Error("Missing projected image")
    expect(estimate(raw, "history")).toBe(615)
    expect(estimate(prepared, "prepared")).toBe(615)
    expect(raw.data).toBe(bytes.toString("base64"))
    expect(raw.detail).toBe(detail)
  })

  it("counts small and high-budget images instead of a fixed 2000-token charge", () => {
    expect(estimator()(image(1024, 1024))).toBe(1229)
    expect(estimator()(image(2048, 2048, "high"))).toBe(3000)
    expect(estimator()(image(1, 1))).toBe(2)
  })
  it("uses the selected model's edge policy and does not infer auto for absent detail", () => {
    expect(estimator("gpt-6-astra")(image(4096, 512))).toBe(2458)
    expect(estimator()(image(4096, 512))).toBe(615)
    expect(estimator()(image(4096, 512, "original"))).toBe(2458)
  })
  it("estimates raw history using the same high-detail projection as the wire", () => {
    const estimate = estimator("gpt-6-astra")
    expect(estimate(image(4096, 512), "history")).toBe(615)
    expect(estimate(image(2048, 256), "prepared")).toBe(615)
    const downgraded = openAIImageTokenEstimator({
      ...context,
      model: {
        ...context.model,
        model: "gpt-6-astra",
        imageDetailModes: ["high"],
      },
    })
    if (downgraded === undefined)
      throw new Error("Missing known-model estimate")
    expect(downgraded(image(4096, 512, "original"), "history")).toBe(615)
  })
  it("distinguishes original resize budgets from newer original rejection ceilings", () => {
    expect(
      estimator("gpt-5.5")(image(6400, 3200, "original")),
    ).toBe(11760)
    expect(estimator()(image(6400, 3200, "original"))).toBe(24000)
    // This input would be rejected by the API. The estimate must not pretend
    // the server resizes it to 10k or 30k patches, or admit/modify it itself.
    expect(estimator()(image(6400, 6400, "original"))).toBe(48000)
  })
  it("reserves a known policy's admitted maximum when dimensions are unavailable", () => {
    const remote: ModelImageBlock = {
      type: "image",
      mediaType: "image/png",
      sizeBytes: 1,
      file: { url: "https://example.com/image.png" },
    }
    expect(estimator()(remote)).toBe(3000)
    expect(estimator()({ ...remote, detail: "original" })).toBe(36000)
    expect(estimator("gpt-5.5")({ ...remote, detail: "original" })).toBe(12000)
  })
  it.each([
    { ...context, serviceId: undefined },
    { ...context, serviceId: "codex" },
    { ...context, serviceId: "moonshot" },
    { ...context, wireApi: "openai_chat_completions" as const },
    {
      ...context,
      model: { ...context.model, usedFallbackModelMetadata: true },
    },
    { ...context, model: { ...context.model, model: "gpt-5.6-sol-custom" } },
    { ...context, model: { ...context.model, model: "gpt-6.1-sol" } },
  ])("does not apply public API facts to unverified transport/model facts: %j", (input) => {
    expect(openAIImageTokenEstimator(input)).toBeUndefined()
  })
  it("uses one captured policy for request and incremental user/tool history without mutating raw images", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [image(6400, 3200, "original")] },
      {
        role: "tool",
        toolCallId: "call",
        content: [image(1024, 1024, "high")],
      },
    ]
    const before = structuredClone(messages)
    const request: ModelRequest = {
      target: {
        provider: "renamed-account",
        model: "gpt-5.6-sol",
        instructionProfileId: "generic",
      },
      messages,
      system: [],
      tools: [],
      toolWireProtocol: "eager",
    }
    const estimate = estimator()
    const budget = estimateModelRequestBudget(request, estimate)
    expect(budget.imageTokens).toBe(25229)
    expect(estimateHistoryTokens(messages, estimate)).toBe(
      budget.messageTokens + budget.imageTokens,
    )
    expect(estimateHistoryTokens(messages, estimate)).toBe(
      estimateHistoryTokens(messages.slice(0, 1), estimate) +
        estimateHistoryTokens(messages.slice(1), estimate),
    )
    expect(messages).toEqual(before)
    // The legacy heuristic remains explicitly unchanged outside this scope.
    expect(estimateModelRequestBudget(request).imageTokens).toBe(12000)
  })
})
