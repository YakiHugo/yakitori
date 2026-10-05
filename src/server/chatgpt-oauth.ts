import { createHash, randomBytes } from "node:crypto"
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose"

// Direct SIWC is separate from Codex's CLI-owned credentials and client ID.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
export const CHATGPT_RESOURCE = "https://api.openai.com/v1"
const ISSUER = "https://auth.openai.com"
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
export const CHATGPT_TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
// Local safety boundary: an abandoned browser authorization cannot be reused indefinitely.
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000

export type ChatGPTRegistration = Readonly<{
  clientId: string
  subject: string
  email?: string
  idToken?: string
}>

export type ChatGPTCredentials = Readonly<{
  issuer: typeof ISSUER
  clientId: string
  subject: string
  email?: string
  idToken: string
  accessToken: string
  refreshToken: string
  scopes: readonly string[]
  expiresAt: number
}>

export class ChatGPTAuthError extends Error {
  readonly code:
    | "invalid_callback"
    | "access_denied"
    | "expired_attempt"
    | "invalid_token"
    | "missing_permission"
    | "exchange_failed"
  constructor(code: ChatGPTAuthError["code"]) {
    // Do not include issuer bodies, JWTs, callback URLs, or underlying parser errors.
    super(`ChatGPT sign-in failed (${code}).`)
    this.name = "ChatGPTAuthError"
    this.code = code
  }
}

// Server-only owner. Its caller must start the loopback listener before exposing
// authorizationUrl and persist a host ID before calling begin. No browser/RPC
// integration is installed merely by importing this module.
export function createChatGPTOAuth(input: {
  hostId: string
  fetchFn?: typeof fetch
  now?: () => number
}) {
  if (
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.hostId,
    )
  )
    throw new Error("ChatGPT host ID must be a persisted UUIDv4 URI.")
  const fetchFn = input.fetchFn ?? fetch
  const now = input.now ?? Date.now
  const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {
    [customFetch]: (url, init) => fetchFn(url, { ...init, redirect: "error" }),
  })
  return {
    begin(
      redirectUri: string,
      selected?: ChatGPTRegistration,
      pendingClientId?: string,
      options: { requestPlanConsent?: boolean } = {},
    ) {
      if (
        pendingClientId !== undefined &&
        (selected !== undefined || !issuedClientId(pendingClientId))
      )
        throw new Error("ChatGPT pending registration is invalid.")
      selected = selected === undefined ? undefined : { ...selected }
      const redirect = new URL(redirectUri)
      if (
        redirect.protocol !== "http:" ||
        redirect.hostname !== "127.0.0.1" ||
        redirect.pathname !== "/auth/callback" ||
        !redirect.port ||
        redirect.username ||
        redirect.password ||
        redirect.search ||
        redirect.hash ||
        redirect.href !== redirectUri
      )
        throw new Error(
          "ChatGPT requires an exact 127.0.0.1 loopback callback.",
        )
      if (selected && (!issuedClientId(selected.clientId) || !selected.subject))
        throw new Error("ChatGPT registration is incomplete.")
      const state = randomBytes(32).toString("base64url")
      const nonce = randomBytes(32).toString("base64url")
      const verifier = randomBytes(64).toString("base64url")
      const expiresAt = now() + ATTEMPT_LIFETIME_MS
      let callbackIssuedClientId = selected?.clientId ?? pendingClientId
      let validatedRegistration: ChatGPTRegistration | undefined
      let consumed = false
      let cancelled = false
      const controller = new AbortController()
      const authorizationUrl = new URL(AUTHORIZE_URL)
      authorizationUrl.search = new URLSearchParams({
        client_id:
          selected?.clientId ?? pendingClientId ?? "dynamic_agent_client",
        ...(selected || pendingClientId ? {} : { agent_name_hint: "Yakitori" }),
        ext_agent_host_id: input.hostId,
        response_type: "code",
        ...(options.requestPlanConsent ? { prompt: "consent" } : {}),
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: CHATGPT_RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        ...(selected?.idToken ? { id_token_hint: selected.idToken } : {}),
        ...(selected?.email ? { login_hint: selected.email } : {}),
      }).toString()
      return {
        // This URL may contain an ID-token hint. Open only in the system browser;
        // never log it or expose it to the renderer's persisted settings/history.
        authorizationUrl: authorizationUrl.href,
        get issuedClientId() {
          return callbackIssuedClientId
        },
        get registration() {
          return validatedRegistration === undefined
            ? undefined
            : { ...validatedRegistration }
        },
        cancel() {
          consumed = true
          cancelled = true
          controller.abort()
        },
        async complete(
          callbackUrl: string,
          persistRegistration?: (clientId: string) => Promise<void>,
        ): Promise<ChatGPTCredentials> {
          if (consumed || now() >= expiresAt)
            throw new ChatGPTAuthError("expired_attempt")
          let callback: URL
          try {
            callback = new URL(callbackUrl)
          } catch {
            throw new ChatGPTAuthError("invalid_callback")
          }
          // Reject unrelated requests without consuming the pending attempt.
          if (
            callback.origin !== redirect.origin ||
            callback.pathname !== redirect.pathname ||
            callback.username ||
            callback.password ||
            callback.hash ||
            callback.searchParams.getAll("state").length !== 1 ||
            callback.searchParams.get("state") !== state
          )
            throw new ChatGPTAuthError("invalid_callback")
          consumed = true // one-time consumption before any asynchronous exchange
          for (const key of ["code", "client_id", "error"])
            if (callback.searchParams.getAll(key).length > 1)
              throw new ChatGPTAuthError("invalid_callback")
          if (callback.searchParams.has("error"))
            throw new ChatGPTAuthError(
              callback.searchParams.get("error") === "access_denied"
                ? "access_denied"
                : "invalid_callback",
            )
          const callbackClientId = callback.searchParams.get("client_id")
          const clientId =
            selected?.clientId ?? pendingClientId ?? callbackClientId
          const code = callback.searchParams.get("code")
          if (
            !clientId ||
            !issuedClientId(clientId) ||
            !code ||
            ((selected || pendingClientId) &&
              callbackClientId !== null &&
              callbackClientId !== (selected?.clientId ?? pendingClientId))
          )
            throw new ChatGPTAuthError("invalid_callback")
          callbackIssuedClientId = clientId
          await persistRegistration?.(clientId)
          if (cancelled || now() >= expiresAt)
            throw new ChatGPTAuthError("expired_attempt")
          let response: Response
          try {
            response = await fetchFn(CHATGPT_TOKEN_URL, {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(15_000),
              ]),
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: clientId,
                code,
                code_verifier: verifier,
                redirect_uri: redirectUri,
                resource: CHATGPT_RESOURCE,
              }),
            })
          } catch (cause) {
            if (cancelled) throw new ChatGPTAuthError("expired_attempt")
            if (
              cause instanceof TypeError ||
              (cause instanceof DOMException &&
                ["AbortError", "TimeoutError"].includes(cause.name))
            )
              throw new ChatGPTAuthError("exchange_failed")
            throw cause
          }
          if (!response.ok) throw new ChatGPTAuthError("exchange_failed")
          let tokens: unknown
          try {
            tokens = await response.json()
          } catch {
            throw new ChatGPTAuthError("invalid_token")
          }
          if (
            !record(tokens) ||
            !text(tokens.id_token) ||
            typeof tokens.scope !== "string"
          )
            throw new ChatGPTAuthError("invalid_token")
          const scopes = [...new Set(tokens.scope.split(/\s+/).filter(Boolean))]
          let identity: Awaited<ReturnType<typeof jwtVerify>>["payload"]
          try {
            const verified = await jwtVerify(tokens.id_token, jwks, {
              issuer: ISSUER,
              audience: clientId,
              requiredClaims: ["sub", "exp", "iat", "nonce"],
              algorithms: ["RS256", "ES256"],
              currentDate: new Date(now()),
              clockTolerance: 5,
            })
            identity = verified.payload
          } catch {
            throw new ChatGPTAuthError("invalid_token")
          }
          if (
            !text(identity.sub) ||
            identity.nonce !== nonce ||
            (selected && identity.sub !== selected.subject) ||
            (identity.azp !== undefined && identity.azp !== clientId) ||
            (Array.isArray(identity.aud) &&
              identity.aud.length > 1 &&
              identity.azp !== clientId)
          )
            throw new ChatGPTAuthError("invalid_token")
          if (cancelled || now() >= expiresAt)
            throw new ChatGPTAuthError("expired_attempt")
          validatedRegistration = {
            clientId,
            subject: identity.sub,
            ...(text(identity.email) ? { email: identity.email } : {}),
          }
          if (
            !["openid", "resource.invoke", "chatgpt.tokens.use.direct"].every(
              (scope) => scopes.includes(scope),
            )
          )
            throw new ChatGPTAuthError("missing_permission")
          if (
            !text(tokens.access_token) ||
            !text(tokens.refresh_token) ||
            tokens.token_type !== "Bearer" ||
            typeof tokens.expires_in !== "number" ||
            !Number.isFinite(tokens.expires_in) ||
            tokens.expires_in <= 0
          )
            throw new ChatGPTAuthError("invalid_token")
          return {
            issuer: ISSUER,
            clientId,
            subject: identity.sub,
            ...(text(identity.email) ? { email: identity.email } : {}),
            idToken: tokens.id_token,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            scopes,
            expiresAt: now() + tokens.expires_in * 1000,
          }
        },
      }
    },
  }
}

function issuedClientId(value: string) {
  return /^oaiapp_[A-Za-z0-9_-]+$/.test(value)
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
