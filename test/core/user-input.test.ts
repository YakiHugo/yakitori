import { describe, expect, it } from "vitest"
import type { ImageAttachment } from "../../src/core/asset-types.ts"
import {
  createUserInput,
  inputContentToModelMessage,
  isInputContent,
  readStoredInputContent,
  replaceInputAttachments,
} from "../../src/core/user-input.ts"

const image: ImageAttachment = {
  name: "photo.png",
  mediaType: "image/png",
  sizeBytes: 10,
  file: {
    rolloutId: "rollout_saved",
    path: "attachments/requests/request_saved/0.png",
  },
}

describe("user input", () => {
  it("rejects non-string attachment media types", () => {
    for (const mediaType of [["image/png"], {}, null, 1])
      expect(
        isInputContent(
          createUserInput("inspect", [
            { ...image, mediaType } as unknown as ImageAttachment,
          ]),
        ),
      ).toBe(false)
  })
  it("keeps rich text positions separate from provider content ordering", () => {
    const input = createUserInput(
      "before[Image 1]after",
      [image],
      [{ startOffset: 6, endOffset: 15, attachmentIndex: 0 }],
    )
    expect(isInputContent(input)).toBe(true)
    expect(inputContentToModelMessage(input)).toEqual({
      role: "user",
      content: [
        { type: "image", ...image, detail: "high" },
        { type: "text", text: "before[Image 1]after" },
      ],
    })
    expect(input.text).toBe("before[Image 1]after")
    expect(input.elements).toEqual([
      { startOffset: 6, endOffset: 15, attachmentIndex: 0 },
    ])
  })

  it("validates ordered UTF-16 ranges and attachment bindings", () => {
    const input = createUserInput(
      "😀[Image 1]",
      [image],
      [{ startOffset: 2, endOffset: 11, attachmentIndex: 0 }],
    )
    expect(isInputContent(input)).toBe(true)
    for (const elements of [
      [{ startOffset: 1, endOffset: 11, attachmentIndex: 0 }],
      [{ startOffset: 2, endOffset: 12, attachmentIndex: 0 }],
      [{ startOffset: 2, endOffset: 11, attachmentIndex: 1 }],
      [
        { startOffset: 2, endOffset: 11, attachmentIndex: 0 },
        { startOffset: 2, endOffset: 11, attachmentIndex: 0 },
      ],
    ])
      expect(isInputContent({ ...input, elements })).toBe(false)
  })

  it("persists public URLs but rejects provider file IDs and unsafe URL schemes", () => {
    const input = createUserInput("inspect", [
      {
        ...image,
        file: { url: "https://cdn.example/photo.png" },
        sizeBytes: 0,
      },
    ])
    expect(isInputContent(input)).toBe(true)
    expect(readStoredInputContent(JSON.parse(JSON.stringify(input)))).toEqual(
      input,
    )
    for (const file of [
      { fileId: "file_provider" },
      { url: "file:///etc/passwd" },
      { url: "https://user:password@example.com/a" },
    ])
      expect(
        isInputContent({ ...input, attachments: [{ ...image, file }] }),
      ).toBe(false)
  })

  it("keeps quote and annotation references separate from authored text", () => {
    const reference = {
      id: "quote_1",
      kind: "selection" as const,
      text: "quoted text",
      source: {
        kind: "message" as const,
        label: "Assistant",
        messageId: "item_1",
      },
    }
    const input = createUserInput("my feedback", [], [], [reference])
    expect(isInputContent(input)).toBe(true)
    expect(inputContentToModelMessage(input)).toEqual({
      role: "user",
      content: [{ type: "text", text: "my feedback" }],
      contextAttachments: [reference],
    })
    expect(input.text).toBe("my feedback")
  })

  it("replaces portable attachment sources without changing markers or text", () => {
    const input = createUserInput(
      "[Image 1]",
      [image],
      [{ startOffset: 0, endOffset: 9, attachmentIndex: 0 }],
    )
    const promoted = {
      ...image,
      file: {
        rolloutId: "rollout_other",
        path: "attachments/requests/request_copy/0.png",
      },
    }
    expect(replaceInputAttachments(input, [promoted])).toEqual({
      ...input,
      attachments: [promoted],
    })
    expect(() => replaceInputAttachments(input, [])).toThrow("do not match")
  })

  it("uses text-only developer input for goals and rejects old input shapes", () => {
    expect(
      inputContentToModelMessage(createUserInput("finish the task"), "goal_1"),
    ).toEqual({
      role: "developer",
      content: [{ type: "text", text: "finish the task" }],
      context: { type: "goal", goalId: "goal_1" },
    })
    expect(() =>
      inputContentToModelMessage(createUserInput("inspect", [image]), "goal_1"),
    ).toThrow("only text")
    expect(() => readStoredInputContent({ kind: "parts", parts: [] })).toThrow(
      "Invalid stored",
    )
  })
})
