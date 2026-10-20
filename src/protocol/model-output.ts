export type AssistantTextPurpose = "commentary" | "final_answer"

export type ModelOutputSource = Readonly<{
  callId: string
  itemId: string
}>

export type ModelOutputPresentation = Readonly<{
  source?: ModelOutputSource
  purpose?: AssistantTextPurpose
  representation?: "summary"
}>

// Display IDs identify parts of one persisted conversation item. The same
// identity is used for deltas, durable completion, and subscription recovery.
export function modelOutputItemId(
  itemId: string,
  kind: "assistant" | "reasoning",
  partIndex = 0,
): string {
  const base = kind === "reasoning" ? `${itemId}_reasoning` : itemId
  return partIndex === 0 ? base : `${base}_part_${partIndex}`
}

export function answerTextParts<
  T extends { purpose?: AssistantTextPurpose | undefined },
>(parts: readonly T[]): T[] {
  const explicit = parts.some((part) => part.purpose === "final_answer")
  return parts.filter((part) =>
    explicit ? part.purpose === "final_answer" : part.purpose !== "commentary",
  )
}
