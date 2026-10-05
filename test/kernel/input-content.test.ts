import { describe, expect, it } from "vitest"
import { isInputContent, type InputContent } from "../../src/kernel/events.ts"
import {
  inputContentText,
  inputContentToModelMessage,
  readStoredInputContent,
  replaceInputImages,
} from "../../src/kernel/input-content.ts"
import {
  fingerprintInputAdmission,
  matchesStoredLegacyInputFingerprint,
} from "../../src/kernel/operation.ts"

const image = {
  type: "image" as const,
  name: "first.png",
  mediaType: "image/png" as const,
  sizeBytes: 42,
  file: {
    rolloutId: "session_saved",
    path: "attachments/requests/request_saved/1.png",
  },
}

describe("ordered user input", () => {
  it("maps authored order, exact text, image names and promotion slots into model history", () => {
    const content: InputContent = {
      kind: "parts",
      parts: [
        { type: "text", text: "before" },
        image,
        { type: "text", text: "after\n" },
        { ...image, name: "second.png" },
      ],
    }
    expect(inputContentText(content)).toBe("beforeafter\n")
    const promoted = replaceInputImages(content, [
      { ...image, file: { rolloutId: "session_new", path: "first.png" } },
      {
        ...image,
        name: "second.png",
        file: { rolloutId: "session_new", path: "second.png" },
      },
    ])
    expect(inputContentToModelMessage(promoted)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "before" },
        {
          ...image,
          detail: "high",
          file: { rolloutId: "session_new", path: "first.png" },
        },
        { type: "text", text: "after\n" },
        {
          ...image,
          name: "second.png",
          detail: "high",
          file: { rolloutId: "session_new", path: "second.png" },
        },
      ],
    })
    expect(content.parts[1]).toEqual(image)
    expect(() => replaceInputImages(content, [])).toThrow("Missing replacement")
  })

  it("admits only text and stored image parts, with no competing side arrays or provider metadata", () => {
    expect(
      isInputContent({
        kind: "parts",
        parts: [image, { type: "text", text: "caption" }],
      }),
    ).toBe(true)
    for (const part of [
      { type: "document", mediaType: "application/pdf" },
      { type: "audio", data: "audio" },
      { type: "text", text: "caption", providerMetadata: {} },
      { ...image, data: "inline" },
    ])
      expect(isInputContent({ kind: "parts", parts: [part] })).toBe(false)
    expect(
      isInputContent({ kind: "parts", parts: [], text: "competing" }),
    ).toBe(false)
    expect(isInputContent({ kind: "parts", parts: [], attachments: [] })).toBe(
      false,
    )
  })

  it("normalizes only actual saved text-then-images records and rejects ambiguous storage", () => {
    const { type: _, ...attachment } = image
    expect(
      readStoredInputContent({
        kind: "text",
        text: "saved",
        attachments: [attachment],
      }),
    ).toEqual({
      kind: "parts",
      parts: [{ type: "text", text: "saved" }, image],
    })
    const ordered = {
      kind: "parts" as const,
      parts: [image, { type: "text" as const, text: "after" }],
    }
    expect(readStoredInputContent(ordered)).toEqual(ordered)
    expect(() =>
      readStoredInputContent({ ...ordered, attachments: [attachment] }),
    ).toThrow("Invalid stored")
    expect(() =>
      readStoredInputContent({
        kind: "text",
        text: "saved",
        attachments: [{ ...attachment, data: "inline" }],
      }),
    ).toThrow("Invalid stored")
  })

  it("retains narrow goal semantics while allowing an empty context list", () => {
    expect(
      inputContentToModelMessage(
        {
          kind: "parts",
          parts: [{ type: "text", text: "continue" }],
          contextAttachments: [],
        },
        "goal_one",
      ),
    ).toEqual({
      role: "developer",
      content: [{ type: "text", text: "continue" }],
      context: { type: "goal", goalId: "goal_one" },
    })
    expect(() =>
      inputContentToModelMessage({ kind: "parts", parts: [image] }, "goal_one"),
    ).toThrow("only text")
  })

  it("fingerprints part positions and restricts legacy replay to a representable old shape", () => {
    const before: InputContent = {
      kind: "parts",
      parts: [{ type: "text", text: "saved" }, image],
    }
    const after: InputContent = {
      kind: "parts",
      parts: [image, { type: "text", text: "saved" }],
    }
    const middle: InputContent = {
      kind: "parts",
      parts: [
        { type: "text", text: "sa" },
        image,
        { type: "text", text: "ved" },
      ],
    }
    const hash = fingerprintInputAdmission({ role: "user", content: before })
    expect(
      fingerprintInputAdmission({ role: "user", content: after }),
    ).not.toBe(hash)
    expect(
      fingerprintInputAdmission({ role: "user", content: middle }),
    ).not.toBe(hash)
    // Frozen hash from the shipped kind:text admission representation.
    const legacy =
      "5585784f4ecc55dc0bdedef40fd41a66f43082d0c4247febd2352e3919c4e38a"
    expect(
      matchesStoredLegacyInputFingerprint(legacy, {
        role: "user",
        content: before,
      }),
    ).toBe(true)
    expect(
      matchesStoredLegacyInputFingerprint(legacy, {
        role: "user",
        content: after,
      }),
    ).toBe(false)
    expect(
      matchesStoredLegacyInputFingerprint(legacy, {
        role: "user",
        content: middle,
      }),
    ).toBe(false)
  })
})
