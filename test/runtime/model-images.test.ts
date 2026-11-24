import { describe, expect, it } from "vitest"
import type {
  ModelImageBlock,
  ModelToolResultMessage,
} from "../../src/runtime/model.ts"
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
  it("counts image occurrences within tool results without counting user attachments", () => {
    const screenshots = [
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
      "sixth",
    ].map(
      (data): ModelImageBlock => ({
        type: "image",
        mediaType: "image/png",
        data,
      }),
    )
    const attachments = [imageMessage, imageMessage] as const
    const separator = { type: "text", text: "next screenshot" } as const
    const tool: ModelToolResultMessage = {
      role: "tool",
      toolCallId: "screenshots",
      content: [...screenshots.slice(0, 1), separator, ...screenshots.slice(1)],
    }
    const result = adaptImagesForModel(
      [attachments[0], tool, attachments[1]],
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        instructionProfileId: "default",
      },
      {
        inputModalities: ["text", "image"],
        imageDetailModes: ["high", "original"],
      },
    )
    const omission = {
      type: "text",
      text: "[Earlier tool screenshot omitted from request context to bound payload size. No local file path is available; do not claim to see omitted images.]",
    }

    expect(result.omittedImageCount).toBe(2)
    expect(result.downgradedOriginalCount).toBe(0)
    expect(result.messages).toEqual([
      attachments[0],
      {
        ...tool,
        content: [omission, separator, omission, ...screenshots.slice(2)],
      },
      attachments[1],
    ])
  })

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
            text: expect.stringContaining("does not have image input enabled"),
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
      provider: "kimi-code",
      model: "k3",
      instructionProfileId: "kimi-code",
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
