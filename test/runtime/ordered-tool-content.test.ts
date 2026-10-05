import { describe, expect, it } from "vitest"
import {
  isModelMessage,
  type ModelMessage,
  type ModelToolResultMessage,
} from "../../src/kernel/index.ts"
import { toAnthropicMessages } from "../../src/runtime/anthropic-provider.ts"
import { toChatCompletionsMessages } from "../../src/runtime/chat-completions-provider.ts"
import { toGeminiContents } from "../../src/runtime/gemini-provider.ts"
import { toOpenAIInput } from "../../src/runtime/openai-provider.ts"
import { adaptImagesForModel } from "../../src/runtime/model-images.ts"
import { finalizeToolContent } from "../../src/runtime/tools/result-output.ts"

const image = {
  type: "image" as const,
  mediaType: "image/png" as const,
  data: "YWJj",
}
const result: ModelToolResultMessage = {
  role: "tool",
  toolCallId: "call_a",
  content: [
    { type: "text", text: "before" },
    image,
    { type: "text", text: "after" },
  ],
}
const call: ModelMessage = {
  role: "assistant",
  content: [
    {
      type: "tool_call",
      id: "call_a",
      name: "inspect",
      input: {},
    },
  ],
}

describe("ordered tool content", () => {
  it("validates durable data parts and rejects side arrays or assistant metadata", () => {
    const stored = {
      ...result,
      content: [
        { type: "text", text: "before" },
        {
          type: "image",
          mediaType: "image/png",
          file: { rolloutId: "rollout_saved", path: "tools/image.png" },
          sizeBytes: 3,
        },
        { type: "text", text: "after" },
      ],
    }
    expect(isModelMessage(stored)).toBe(true)
    expect(isModelMessage({ ...stored, images: [] })).toBe(false)
    expect(isModelMessage({ ...stored, content: "legacy" })).toBe(false)
    expect(
      isModelMessage({
        ...stored,
        content: [
          { type: "text", text: "host", providerMetadata: { private: true } },
        ],
      }),
    ).toBe(false)
  })

  it("preserves native tool text/image/text and error attribution without mutating history", () => {
    const error = { ...result, isError: true }
    const before = structuredClone(error)
    expect(toOpenAIInput([error])).toEqual([
      {
        type: "function_call_output",
        call_id: "call_a",
        output: [
          { type: "input_text", text: "[tool_error]" },
          { type: "input_text", text: "before" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,YWJj",
            detail: "high",
          },
          { type: "input_text", text: "after" },
        ],
      },
    ])
    expect(toAnthropicMessages([error])).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_a",
            is_error: true,
            content: [
              { type: "text", text: "before" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "YWJj",
                },
              },
              { type: "text", text: "after" },
            ],
          },
        ],
      },
    ])
    expect(error).toEqual(before)
  })

  it("binds Gemini 3 image references at their source positions", () => {
    expect(
      toGeminiContents(
        [call, result],
        "gemini",
        undefined,
        "gemini-3-pro-preview",
      )[1],
    ).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "inspect",
            response: {
              output: [
                { text: "before" },
                { $ref: "tool_0_image_0" },
                { text: "after" },
              ],
            },
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  displayName: "tool_0_image_0",
                  data: "YWJj",
                },
              },
            ],
          },
        },
      ],
    })
  })

  it("keeps Chat tool text in its own role and labels the displaced image position", () => {
    const messages = toChatCompletionsMessages([call, result], "openai-chat")
    expect(messages.slice(1)).toEqual([
      {
        role: "tool",
        tool_call_id: "call_a",
        content:
          'before\n[Image from tool result "call_a", content part 2; image follows the tool-result batch.]\nafter',
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Image from tool result "call_a", content part 2:',
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YWJj", detail: "high" },
          },
        ],
      },
    ])
  })

  it("replaces unsupported images in place while keeping the durable source unchanged", () => {
    const projected = adaptImagesForModel(
      [result],
      { provider: "custom", model: "text", instructionProfileId: "default" },
      { inputModalities: ["text"], imageDetailModes: [] },
    )
    expect(projected.omittedImageCount).toBe(1)
    expect(projected.messages[0]?.content).toEqual([
      { type: "text", text: "before" },
      {
        type: "text",
        text: expect.stringContaining("does not support image input"),
      },
      { type: "text", text: "after" },
    ])
    expect(result.content).toEqual([
      { type: "text", text: "before" },
      image,
      { type: "text", text: "after" },
    ])
  })

  it("uses a single UTF-8 and line budget across text parts without truncating media", async () => {
    const content = [
      { type: "text" as const, text: "😀".repeat(200) },
      image,
      { type: "text" as const, text: "later\n".repeat(200) },
      image,
    ]
    const projected = await finalizeToolContent(
      content,
      { maxBytes: 100, maxLines: 2 },
      { workspaceRoot: "/unused" },
    )
    expect(projected.toolContentTruncated).toBe(true)
    expect(projected.content).toEqual([
      {
        type: "text",
        text: "[Output truncated. Full output unavailable: no rollout asset storage.]",
      },
      { type: "text", text: "😀😀😀😀😀😀😀" },
      image,
      image,
    ])
    const text = projected.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100)
    expect(text.split("\n")).toHaveLength(2)
    expect(content[0]).toEqual({ type: "text", text: "😀".repeat(200) })
  })
})
