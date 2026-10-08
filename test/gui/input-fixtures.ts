import type { InputDraft } from "../../src/core/user-input.ts"
import type { ImageAttachment } from "../../src/kernel/events.ts"
import { inputFixture } from "../fixtures/user-input.ts"

// Known fixture order for tests migrated from separate text and image fields.
// Expectations use explicit fixture data, never production conversion helpers.
export function inputParts(
  text: string,
  images: readonly ImageAttachment[] = [],
): InputDraft {
  return inputFixture([
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...images.map((image) => ({ ...image, type: "image" as const })),
  ])
}
