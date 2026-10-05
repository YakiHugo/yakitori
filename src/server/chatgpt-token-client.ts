import { createRemoteJWKSet, customFetch, jwtVerify, errors } from "jose"
import {
  ChatGPTRefreshRevokedError,
  ChatGPTPendingRenewalExpiredError,
  type ChatGPTPendingRenewal,
} from "./chatgpt-credential-store.ts"
import {
  CHATGPT_RESOURCE,
  CHATGPT_TOKEN_URL,
  type ChatGPTCredentials,
} from "./chatgpt-oauth.ts"

const ISSUER = "https://auth.openai.com"
const TERMINAL_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
])

// Network protocol only. The credential store owns serialization and atomic
// replacement; these methods never read another tool's credential files.
export function createChatGPTTokenClient(
  input: { fetchFn?: typeof fetch; now?: () => number } = {},
) {
  const fetchFn = input.fetchFn ?? fetch
  const now = input.now ?? Date.now
  const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {
    [customFetch]: (url, init) => fetchFn(url, { ...init, redirect: "error" }),
  })
  const request = async (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ) => {
    try {
      return await fetchFn(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
    } catch (cause) {
      if (
        cause instanceof TypeError ||
        (cause instanceof DOMException &&
          ["TimeoutError", "AbortError"].includes(cause.name))
      )
        throw new Error("ChatGPT authentication service could not be reached.")
      throw cause
    }
  }
  return {
    async refresh(
      previous: ChatGPTCredentials,
      signal: AbortSignal,
    ): Promise<ChatGPTPendingRenewal> {
      const response = await request(
        CHATGPT_TOKEN_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: previous.clientId,
            refresh_token: previous.refreshToken,
            resource: CHATGPT_RESOURCE,
          }),
        },
        signal,
      )
      let value: unknown
      try {
        value = await response.json()
      } catch {
        throw new Error("ChatGPT token refresh returned invalid data.")
      }
      if (!response.ok) {
        if (
          record(value) &&
          typeof value.error === "string" &&
          TERMINAL_REFRESH_CODES.has(value.error)
        )
          throw new ChatGPTRefreshRevokedError()
        throw new Error(
          `ChatGPT token refresh failed (HTTP ${response.status}).`,
        )
      }
      if (
        !record(value) ||
        !text(value.access_token) ||
        !text(value.refresh_token) ||
        value.token_type !== "Bearer" ||
        typeof value.expires_in !== "number" ||
        !Number.isFinite(value.expires_in) ||
        value.expires_in <= 0 ||
        (value.scope !== undefined && typeof value.scope !== "string") ||
        (value.id_token !== undefined && !text(value.id_token))
      )
        throw new Error("ChatGPT token refresh returned invalid data.")
      const scopes =
        typeof value.scope === "string"
          ? [...new Set(value.scope.split(/\s+/).filter(Boolean))]
          : [...previous.scopes]
      if (
        !["openid", "resource.invoke", "chatgpt.tokens.use.direct"].every(
          (scope) => scopes.includes(scope),
        )
      )
        throw new ChatGPTRefreshRevokedError()
      // Persist this replacement as inactive before any JWKS lookup. A temporary
      // verification failure must not discard a consumed rotating token.
      return {
        accessToken: value.access_token,
        refreshToken: value.refresh_token,
        ...(typeof value.id_token === "string"
          ? { idToken: value.id_token }
          : {}),
        expiresAt: now() + value.expires_in * 1000,
        scopes,
      }
    },
    async verifyRefresh(
      previous: ChatGPTCredentials,
      pending: ChatGPTPendingRenewal,
      signal: AbortSignal,
    ): Promise<ChatGPTCredentials> {
      let idToken = previous.idToken
      if (pending.idToken !== undefined) {
        try {
          const { payload } = await jwtVerify(pending.idToken, jwks, {
            issuer: ISSUER,
            audience: previous.clientId,
            requiredClaims: ["sub", "exp", "iat"],
            algorithms: ["RS256", "ES256"],
            currentDate: new Date(now()),
            clockTolerance: 5,
          })
          if (
            payload.sub !== previous.subject ||
            (payload.azp !== undefined && payload.azp !== previous.clientId) ||
            (Array.isArray(payload.aud) &&
              payload.aud.length > 1 &&
              payload.azp !== previous.clientId)
          )
            throw new Error("Identity mismatch")
        } catch (cause) {
          if (cause instanceof errors.JWTExpired)
            throw new ChatGPTPendingRenewalExpiredError()
          throw new Error("ChatGPT refreshed identity could not be verified.")
        }
        idToken = pending.idToken
      }
      signal.throwIfAborted()
      return {
        ...previous,
        idToken,
        accessToken: pending.accessToken,
        refreshToken: pending.refreshToken,
        expiresAt: pending.expiresAt,
        scopes: pending.scopes,
      }
    },
    async revoke(
      credentials: ChatGPTCredentials,
      signal: AbortSignal,
    ): Promise<void> {
      const discovery = await request(
        `${ISSUER}/.well-known/openid-configuration`,
        {},
        signal,
      )
      if (!discovery.ok) throw new Error("ChatGPT sign-out discovery failed.")
      let value: unknown
      try {
        value = await discovery.json()
      } catch {
        throw new Error("ChatGPT sign-out discovery returned invalid data.")
      }
      if (
        !record(value) ||
        value.issuer !== ISSUER ||
        typeof value.revocation_endpoint !== "string"
      )
        throw new Error("ChatGPT sign-out discovery returned invalid data.")
      let endpoint: URL
      try {
        endpoint = new URL(value.revocation_endpoint)
      } catch {
        throw new Error("ChatGPT sign-out endpoint is invalid.")
      }
      if (
        endpoint.origin !== ISSUER ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error("ChatGPT sign-out endpoint is invalid.")
      for (let attempt = 0; attempt < 2; attempt++) {
        let response: Response | undefined
        try {
          response = await request(
            endpoint.href,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: credentials.refreshToken,
                token_type_hint: "refresh_token",
                client_id: credentials.clientId,
              }),
            },
            signal,
          )
        } catch (cause) {
          if (signal.aborted || attempt === 1) throw cause
          if (
            !(cause instanceof Error) ||
            cause.message !==
              "ChatGPT authentication service could not be reached."
          )
            throw cause
        }
        if (response?.status === 200) return
        if (response && response.status < 500)
          throw new Error(`ChatGPT sign-out failed (HTTP ${response.status}).`)
        if (attempt === 1)
          throw new Error("ChatGPT remote sign-out could not be confirmed.")
        // A bounded retry for transient revocation failure; never repeat refresh.
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
        signal.throwIfAborted()
      }
    },
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
