import { describe, expect, it } from "vitest"
import {
  isModelMessage,
  type ModelUserMessage,
} from "../../src/kernel/events.ts"
import { toAnthropicMessages } from "../../src/runtime/anthropic-provider.ts"
import { toChatCompletionsMessages } from "../../src/runtime/chat-completions-provider.ts"
import { toGeminiContents } from "../../src/runtime/gemini-provider.ts"
import { toOpenAIInput } from "../../src/runtime/openai-provider.ts"
import { adaptImagesForModel } from "../../src/runtime/model-images.ts"
import { estimateHistoryTokens } from "../../src/runtime/model-request-budget.ts"

const first = {
  type: "image" as const,
  mediaType: "image/png" as const,
  data: "Zmlyc3Q=",
  detail: "original" as const,
}
const second = {
  type: "image" as const,
  mediaType: "image/jpeg" as const,
  data: "c2Vjb25k",
}
const message: ModelUserMessage = {
  role: "user",
  content: [
    first,
    { type: "text", text: "Compare this with the next image" },
    second,
  ],
}

describe("ordered user content", () => {
  it("accepts ordered user images while keeping developer and legacy side arrays out of canonical IR", () => {
    const stored = {
      role: "user",
      content: [
        {
          type: "image",
          mediaType: "image/png",
          file: { rolloutId: "rollout_saved", path: "attachments/first.png" },
          sizeBytes: 24,
        },
        { type: "text", text: "between" },
        {
          type: "image",
          mediaType: "image/jpeg",
          file: { rolloutId: "rollout_saved", path: "attachments/second.jpg" },
          sizeBytes: 24,
        },
      ],
    }
    expect(isModelMessage(stored)).toBe(true)
    expect(isModelMessage({ ...stored, role: "developer" })).toBe(false)
    expect(isModelMessage(message)).toBe(false)
    expect(isModelMessage({ ...message, role: "developer" })).toBe(false)
    expect(isModelMessage({ ...message, images: [first] })).toBe(false)
    expect(
      isModelMessage({
        role: "user",
        content: [{ ...first, data: undefined }],
      }),
    ).toBe(false)
  })

  it("preserves image/text/image in Responses and Codex wire input", () => {
    expect(toOpenAIInput([message])).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,Zmlyc3Q=",
            detail: "original",
          },
          { type: "input_text", text: "Compare this with the next image" },
          {
            type: "input_image",
            image_url: "data:image/jpeg;base64,c2Vjb25k",
            detail: "high",
          },
        ],
      },
    ])
  })

  it("preserves image/text/image in Chat Completions", () => {
    expect(toChatCompletionsMessages([message], "grok")).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,Zmlyc3Q=",
              detail: "high",
            },
          },
          { type: "text", text: "Compare this with the next image" },
          {
            type: "image_url",
            image_url: {
              url: "data:image/jpeg;base64,c2Vjb25k",
              detail: "high",
            },
          },
        ],
      },
    ])
  })

  it("preserves image/text/image in Messages", () => {
    expect(toAnthropicMessages([message])).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "Zmlyc3Q=",
            },
          },
          { type: "text", text: "Compare this with the next image" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "c2Vjb25k",
            },
          },
        ],
      },
    ])
  })

  it("preserves image/text/image in native Gemini parts", () => {
    expect(toGeminiContents([message], "gemini")).toEqual([
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: "Zmlyc3Q=" } },
          { text: "Compare this with the next image" },
          { inlineData: { mimeType: "image/jpeg", data: "c2Vjb25k" } },
        ],
      },
    ])
  })

  it("replaces unsupported image slots in place without mutating durable content", () => {
    const result = adaptImagesForModel(
      [message],
      { provider: "test", model: "text-only", instructionProfileId: "default" },
      { inputModalities: ["text"], imageDetailModes: [] },
    )
    expect(result.omittedImageCount).toBe(2)
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Attached image was not sent"),
          },
          { type: "text", text: "Compare this with the next image" },
          {
            type: "text",
            text: expect.stringContaining("Attached image was not sent"),
          },
        ],
      },
    ])
    expect(message.content).toEqual([
      first,
      { type: "text", text: "Compare this with the next image" },
      second,
    ])
  })

  it("downgrades image detail without moving image slots or charging base64 as text", () => {
    const result = adaptImagesForModel(
      [message],
      { provider: "test", model: "vision", instructionProfileId: "default" },
      { inputModalities: ["text", "image"], imageDetailModes: ["high"] },
    )
    expect(result.downgradedOriginalCount).toBe(1)
    const adapted = result.messages[0]
    expect(adapted?.role === "user" && adapted.content.slice(0, 3)).toEqual([
      { ...first, detail: "high" },
      message.content[1],
      second,
    ])
    expect(estimateHistoryTokens([message])).toBeGreaterThanOrEqual(4_000)
    expect(
      estimateHistoryTokens([
        {
          role: "user",
          content: [
            { ...first, data: "x".repeat(100_000) },
            { type: "text", text: "Compare this with the next image" },
            second,
          ],
        },
      ]),
    ).toBe(estimateHistoryTokens([message]))
  })
})
