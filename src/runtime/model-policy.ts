// Picker defaults are Yakitori policy, independent of whether an endpoint can
// execute an explicitly selected model. User visibility overrides apply last.
const hiddenCodexModels = new Set([
  "gpt-reserve",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
])

export function modelVisibleByDefault(
  provider: string,
  model: string,
  sourceVisible = true,
): boolean {
  if (!sourceVisible) return false
  if (provider === "codex" && hiddenCodexModels.has(model.toLowerCase()))
    return false
  if (provider === "openai")
    return (
      /^(gpt-|chatgpt-|o[1-9](?:-|$)|codex-)/.test(model) &&
      !/-(audio|realtime|image|transcribe|tts)(-|$)/.test(model)
    )
  return true
}
