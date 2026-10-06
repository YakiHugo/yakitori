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

// Ordinary user PDFs predate multimodal function responses. Keep these gates
// separate: Gemini 2.5 accepts a PDF in user parts, not inside tool responses.
// https://ai.google.dev/gemini-api/docs/generate-content/document-processing
const geminiUserPdfModels = new Set([
  ...geminiToolPdfModels,
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
])

export function supportsGeminiUserPdf(model: string): boolean {
  return geminiUserPdfModels.has(model.replace(/^models\//, ""))
}

// User file parts do not have Chat's separate tool/effort restriction.
// Request compatibility is checked independently before sending tools/history.
// https://developers.openai.com/api/docs/guides/file-inputs
export function supportsOpenAIChatUserPdf(model: string): boolean {
  return [
    "gpt-5",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
  ].includes(model)
}

// Overall inline payload, distinct from the 50 MB per-PDF processing limit.
// https://ai.google.dev/gemini-api/docs/generate-content/file-input-methods
export const GEMINI_INLINE_REQUEST_MAX_BYTES = 100_000_000

// Messages limits the whole JSON request, not raw bytes per PDF. Decimal MB is
// a conservative interpretation of the documented unit; the final wire guard
// also includes system text, tools, images and serialization overhead.
// https://platform.claude.com/docs/en/api/errors#request-size-limits
export const ANTHROPIC_REQUEST_MAX_BYTES = 32_000_000

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
