import { createHash } from "node:crypto"
import {
  CODEX_API_BASE_URL,
  createCodexAuthProvider,
  type CodexAuthProvider,
} from "./codex-credentials.ts"
import type { ModelStreamEvent, StreamFn } from "./model.ts"
import { createOpenAIProvider } from "./openai-provider.ts"

// Reuses the local codex CLI's ChatGPT OAuth login against the Responses-API
// codex backend. Tokens resolve lazily per model call (same pattern as the
// Grok CLI stream): a refreshed or rotated login is picked up without a
// restart, and no token is frozen at application startup.
export function createCodexProvider(input?: {
  readonly credentialsPath?: string
  readonly auth?: CodexAuthProvider
  readonly createStream?: typeof createOpenAIProvider
}): StreamFn {
  const auth =
    input?.auth ??
    createCodexAuthProvider(
      input?.credentialsPath === undefined
        ? {}
        : { path: input.credentialsPath },
    )
  const createStream = input?.createStream ?? createOpenAIProvider
  // Codex's sticky routing token belongs to one Turn, including its retries.
  // The caller must create a fresh stream for each Turn.
  let turnState: string | undefined
  let expectedAccountId: string | undefined
  let accountBound = false
  const stream: StreamFn = async function* (request) {
    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      const token = await auth.resolve(
        authAttempt === 0 ? {} : { forceRefresh: true },
      )
      if (!accountBound) {
        expectedAccountId = token.accountId
        accountBound = true
      } else if (token.accountId !== expectedAccountId) {
        yield accountChangedResponse()
        return
      }
      const scopedRequest =
        token.accountId === undefined
          ? request
          : {
              ...request,
              continuationScope: codexAccountScope(token.accountId),
            }
      let outputObserved = false
      let recoverUnauthorized = false
      for await (const event of createStream({
        apiKey: token.accessToken,
        model: request.target.model,
        baseURL: CODEX_API_BASE_URL,
        defaultHeaders: {
          ...(token.accountId === undefined
            ? {}
            : { "chatgpt-account-id": token.accountId }),
          ...(request.cacheKey === undefined
            ? {}
            : { "session-id": request.cacheKey }),
          ...(turnState === undefined
            ? {}
            : { "x-codex-turn-state": turnState }),
        },
        onResponseHeaders(headers) {
          // Like Codex's OnceLock, retain the first token unchanged.
          turnState ??= headers.get("x-codex-turn-state") ?? undefined
        },
      })(scopedRequest)) {
        if (authAttempt === 0 && !outputObserved && isUnauthorized(event)) {
          if (expectedAccountId === undefined) {
            yield event
            return
          }
          recoverUnauthorized = true
          auth.invalidate()
          break
        }
        if (event.type !== "response") outputObserved = true
        yield event
      }
      if (!recoverUnauthorized) return
    }
  }
  return stream
}

function codexAccountScope(accountId: string): string {
  return `codex:${createHash("sha256").update(accountId).digest("hex")}`
}

function accountChangedResponse(): ModelStreamEvent {
  return {
    type: "response",
    response: {
      stopReason: "error",
      content: [],
      error: {
        code: "codex_account_changed",
        message:
          "Codex login changed accounts during the turn; no request was sent to the new account.",
      },
    },
  }
}

function isUnauthorized(event: ModelStreamEvent): boolean {
  return (
    event.type === "response" && event.response.error?.details?.status === 401
  )
}
