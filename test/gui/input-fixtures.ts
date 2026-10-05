import type { ImageAttachment, InputPart } from "../../src/kernel/events.ts"

// Known fixture order for tests migrated from separate text and image fields.
// Expectations use explicit fixture data, never production conversion helpers.
export function inputParts(
  text: string,
  images: readonly ImageAttachment[] = [],
): InputPart[] {
  return [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...images.map((image) => ({ ...image, type: "image" as const })),
  ]
}
