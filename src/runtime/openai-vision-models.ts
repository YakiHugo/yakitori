// Public API vision facts only, not Codex client budgets or whole-model metadata.
// https://developers.openai.com/api/docs/guides/images-vision (2026-11-03)
// GPT-6 Sol/Luna are image-capable, but their patch/detail rules are not listed:
// do not infer them from Astra or a shared model-name prefix.
export function openAIVisionPolicy(model: string):
  | {
      highMaxDimension: number
      originalMaxDimension: number
      originalPatchBudget?: number
    }
  | undefined {
  switch (model) {
    case "gpt-6-astra":
      return { highMaxDimension: 65535, originalMaxDimension: 65535 }
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
      return { highMaxDimension: 2048, originalMaxDimension: 65535 }
    case "gpt-5.5":
    case "gpt-5.4":
    case "gpt-5.4-mini":
    case "gpt-5.4-nano":
      return {
        highMaxDimension: 2048,
        originalMaxDimension: 6000,
        originalPatchBudget: 10000,
      }
    default:
      return undefined
  }
}

// These model pages confirm image input but publish no original-detail or
// patch accounting rule. Use the common native format/resource guard only.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-6.1-terra
export function hasOpenAIImagePreparation(model: string): boolean {
  return (
    openAIVisionPolicy(model) !== undefined ||
    model === "gpt-6.1-sol" ||
    model === "gpt-6.1-terra"
  )
}
