import { expect, it } from "vitest"
import { isInputContent } from "../../src/core/user-input.ts"
import {
  draftFromEditorParts,
  draftToEditorParts,
  inputDisplayParts,
  joinInputDrafts,
  sameInputDraft,
  trimInputDraft,
} from "../../src/gui/input-draft.ts"

const image = {
  type: "image" as const,
  name: "a.png",
  mediaType: "image/png" as const,
  sizeBytes: 1,
  file: { rolloutId: "session_a", path: "attachments/a/a.png" },
}
const document = {
  type: "document" as const,
  name: "b.pdf",
  mediaType: "application/pdf" as const,
  sizeBytes: 2,
  file: { rolloutId: "session_a", path: "attachments/b/b.pdf" },
}

it("preserves UTF-16 marker identity when trimming and joining text/media drafts", () => {
  const first = trimInputDraft(
    draftFromEditorParts([
      { type: "text", text: "  🌈" },
      image,
      { type: "text", text: " end  " },
    ]),
  )
  const second = draftFromEditorParts([
    document,
    { type: "text", text: " next" },
  ])
  const joined = joinInputDrafts([first, undefined, second])
  expect(joined.text).toBe("🌈[Image 1] end\n[Document 1] next")
  expect(joined.elements).toEqual([
    { startOffset: 2, endOffset: 11, attachmentIndex: 0 },
    { startOffset: 16, endOffset: 28, attachmentIndex: 1 },
  ])
  expect(isInputContent(joined)).toBe(true)
  expect(draftToEditorParts(joined)).toEqual([
    { type: "text", text: "🌈" },
    image,
    { type: "text", text: " end\n" },
    document,
    { type: "text", text: " next" },
  ])
  expect(inputDisplayParts(joined)).toEqual([
    image,
    document,
    { type: "text", text: "🌈[Image 1] end\n[Document 1] next" },
  ])
})

it("distinguishes changed attachment ownership and detail while keeping equal snapshots equal", () => {
  const input = draftFromEditorParts([image])
  const attachment = input.attachments[0]
  if (!attachment) throw new Error("Expected image attachment")
  expect(sameInputDraft(input, structuredClone(input))).toBe(true)
  expect(
    sameInputDraft(input, {
      ...input,
      attachments: [
        {
          ...attachment,
          file: { rolloutId: "session_b", path: image.file.path },
        },
      ],
    }),
  ).toBe(false)
  expect(
    sameInputDraft(
      input,
      draftFromEditorParts([{ ...image, detail: "original" }]),
    ),
  ).toBe(false)
})
