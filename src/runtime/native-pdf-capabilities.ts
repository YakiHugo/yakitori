// GenerateContent supports PDF-bearing function responses on Gemini 3. Keep
// automatic tool projection bounded to documented model IDs, not user aliases.
// https://ai.google.dev/gemini-api/docs/generate-content/function-calling
const geminiToolPdfModels = new Set([
  "gemini-3.8-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
])

export function supportsGeminiToolPdf(model: string): boolean {
  return geminiToolPdfModels.has(model.replace(/^models\//, ""))
}

// Overall inline payload, distinct from the 50 MB per-PDF processing limit.
// https://ai.google.dev/gemini-api/docs/generate-content/file-input-methods
export const GEMINI_INLINE_REQUEST_MAX_BYTES = 100_000_000

// A vision-capable catalog entry is not enough: Codex is Responses-only;
// Astra/6.1 Sol tool calls require Responses, and Sol/Luna Chat tools require
// explicit non-reasoning mode. Never silently change the user's reasoning.
// https://developers.openai.com/api/docs/guides/latest-model
// https://developers.openai.com/api/docs/models/gpt-5.1-codex
export function supportsOpenAIChatToolPdf(
  model: string,
  effort?: string,
): boolean {
  return (
    model === "gpt-5" ||
    ((model === "gpt-6-sol" || model === "gpt-6-luna") && effort === "none")
  )
}
