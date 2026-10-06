import { describe, expect, it } from "vitest"
import type { ModelUserMessage } from "../../src/kernel/events.ts"
import { toAnthropicMessages } from "../../src/runtime/anthropic-provider.ts"
import { toChatCompletionsMessages } from "../../src/runtime/chat-completions-provider.ts"
import { toGeminiContents } from "../../src/runtime/gemini-provider.ts"
import { toOpenAIInput } from "../../src/runtime/openai-provider.ts"

const pdf = {
  type: "document" as const,
  name: "report.pdf",
  mediaType: "application/pdf" as const,
  file: { rolloutId: "rollout_saved", path: "attachments/report.pdf" },
  sizeBytes: 6,
  data: "JVBERi0x",
}
const message: ModelUserMessage = {
  role: "user",
  content: [
    { type: "text", text: "Before" },
    pdf,
    { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
    { type: "text", text: "Between" },
    { ...pdf, name: "second.pdf", data: "JVBERi0y" },
    { type: "text", text: "After" },
  ],
}

describe("ordered user PDF wire content", () => {
  it("keeps Responses user files at their source slots", () => {
    expect(toOpenAIInput([message])).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Before" },
          {
            type: "input_file",
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,JVBERi0x",
          },
          {
            type: "input_image",
            image_url: "data:image/png;base64,aW1hZ2U=",
            detail: "high",
          },
          { type: "input_text", text: "Between" },
          {
            type: "input_file",
            filename: "second.pdf",
            file_data: "data:application/pdf;base64,JVBERi0y",
          },
          { type: "input_text", text: "After" },
        ],
      },
    ])
  })

  it("keeps Chat user file parts in their original message without tool-source labels", () => {
    expect(toChatCompletionsMessages([message], "personal")).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Before" },
          {
            type: "file",
            file: {
              filename: "report.pdf",
              file_data: "data:application/pdf;base64,JVBERi0x",
            },
          },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,aW1hZ2U=",
              detail: "high",
            },
          },
          { type: "text", text: "Between" },
          {
            type: "file",
            file: {
              filename: "second.pdf",
              file_data: "data:application/pdf;base64,JVBERi0y",
            },
          },
          { type: "text", text: "After" },
        ],
      },
    ])
  })

  it("keeps Anthropic user documents separate from tool-result envelopes", () => {
    expect(toAnthropicMessages([message])).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Before" },
          {
            type: "document",
            title: "report.pdf",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0x",
            },
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
          { type: "text", text: "Between" },
          {
            type: "document",
            title: "second.pdf",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0y",
            },
          },
          { type: "text", text: "After" },
        ],
      },
    ])
  })

  it.each([
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "models/gemini-3.8-flash",
  ])("sends ordinary user PDF parts to %s", (model) => {
    expect(toGeminiContents([message], "personal", undefined, model)).toEqual([
      {
        role: "user",
        parts: [
          { text: "Before" },
          { inlineData: { mimeType: "application/pdf", data: "JVBERi0x" } },
          { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
          { text: "Between" },
          { inlineData: { mimeType: "application/pdf", data: "JVBERi0y" } },
          { text: "After" },
        ],
      },
    ])
  })

  it.each([
    ["Responses", (input: ModelUserMessage) => toOpenAIInput([input])],
    [
      "Chat",
      (input: ModelUserMessage) =>
        toChatCompletionsMessages([input], "personal"),
    ],
    ["Messages", (input: ModelUserMessage) => toAnthropicMessages([input])],
    [
      "Gemini",
      (input: ModelUserMessage) =>
        toGeminiContents([input], "personal", undefined, "gemini-2.5-pro"),
    ],
  ] as const)("fails unresolved user PDFs before serialization in %s", (_name, convert) => {
    const { data: _, ...unresolved } = pdf
    expect(() => convert({ role: "user", content: [unresolved] })).toThrow(
      "unresolved Session PDF",
    )
  })

  it("keeps unsupported Gemini user PDFs as in-place notices without leaking bytes", () => {
    const content = toGeminiContents(
      [message],
      "personal",
      undefined,
      "gemini-4-custom",
    )
    expect(content[0]?.parts.map((part) => part.text ?? "image")).toEqual([
      "Before",
      "[Document report.pdf was not sent: native PDF input is not enabled for Gemini.]",
      "image",
      "Between",
      "[Document second.pdf was not sent: native PDF input is not enabled for Gemini.]",
      "After",
    ])
    expect(JSON.stringify(content)).not.toContain("JVBERi0")
  })

  it("preserves the Responses-compatible backend gate for user PDF bytes", () => {
    const content = toOpenAIInput([message], true, "custom")
    expect(JSON.stringify(content)).not.toContain("JVBERi0")
    expect(JSON.stringify(content)).toContain("native PDF input is not enabled")
  })
})
