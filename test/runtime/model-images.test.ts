import { describe, expect, it } from "vitest"
import { adaptImagesForModel } from "../../src/runtime/model-images.ts"

const imageMessage = {
  role: "user" as const,
  content: [
    { type: "text" as const, text: "inspect" },
    {
      type: "image" as const,
      mediaType: "image/png" as const,
      detail: "original" as const,
      data: "aGVsbG8=",
    },
  ],
}

describe("model image adaptation", () => {
  it("replaces unsupported images with a model-visible notice", () => {
    const result = adaptImagesForModel([imageMessage], {
      provider: "unknown",
      model: "text-only",
      instructionProfileId: "default",
    })

    expect(result.omittedImageCount).toBe(1)
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "text",
            text: expect.stringContaining("does not support image input"),
          },
        ],
      },
    ])
  })

  it("downgrades original to high for protocols without original", () => {
    const grok = adaptImagesForModel([imageMessage], {
      provider: "grok",
      model: "grok-4.6",
      instructionProfileId: "grok",
    })
    expect(grok.downgradedOriginalCount).toBe(1)
    expect(
      grok.messages[0]?.role === "user"
        ? grok.messages[0].content.filter((block) => block.type === "image")[0]
            ?.detail
        : undefined,
    ).toBe("high")

    const kimi = adaptImagesForModel([imageMessage], {
      provider: "kimi",
      model: "k3",
      instructionProfileId: "kimi",
    })
    expect(kimi.downgradedOriginalCount).toBe(1)
    expect(imageMessage.content[1]).toMatchObject({ detail: "original" })
    expect(
      kimi.messages[0]?.role === "user"
        ? kimi.messages[0].content.filter((block) => block.type === "image")[0]
            ?.detail
        : undefined,
    ).toBe("high")
  })
})
