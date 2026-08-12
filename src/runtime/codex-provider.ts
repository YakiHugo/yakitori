import {
  CODEX_API_BASE_URL,
  resolveCodexAccessToken,
} from "./codex-credentials.ts"
import type { StreamFn } from "./model.ts"
import { createOpenAIProvider } from "./openai-provider.ts"
import { withRetries } from "./retrying-stream.ts"

// Reuses the local codex CLI's ChatGPT OAuth login against the Responses-API
// codex backend. Tokens resolve lazily per model call (same pattern as the
// Grok CLI stream): a refreshed or rotated login is picked up without a
// restart, and no token is frozen at application startup.
export function createCodexProvider(input?: {
  readonly credentialsPath?: string
}): StreamFn {
  const credentialsPath = input?.credentialsPath
  const stream: StreamFn = async function* (request) {
    const token = await resolveCodexAccessToken(
      credentialsPath === undefined ? {} : { path: credentialsPath },
    )
    yield* createOpenAIProvider({
      apiKey: token.accessToken,
      model: request.target.model,
      baseURL: CODEX_API_BASE_URL,
      ...(token.accountId === undefined
        ? {}
        : { defaultHeaders: { "chatgpt-account-id": token.accountId } }),
    })(request)
  }
  return withRetries(stream)
}
