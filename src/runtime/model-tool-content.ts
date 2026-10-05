import type { ModelToolContentBlock } from "../kernel/index.ts"

// Human previews and text-only protocol fields are deliberately lossy. The
// ordered blocks, not this string, remain authoritative for replay and assets.
export function toolContentText(
  content: readonly ModelToolContentBlock[],
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}
