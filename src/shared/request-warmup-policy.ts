// Wire compatibility alone is not evidence for non-generating requests. In
// particular, the ChatGPT subscription backend is not the public OpenAI API.
export function supportsOpenAIRequestWarmup(baseURL: string): boolean {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }
  return url.href.replace(/\/$/, "") === "https://api.openai.com/v1"
}
