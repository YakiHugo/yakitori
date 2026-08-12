import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// ChatGPT OAuth login shared read-only with the official codex CLI
// (~/.codex/auth.json, or $CODEX_HOME/auth.json). v1 never writes the file
// back: refreshed tokens live in memory only, and the CLI's own refresh
// updates the file for the next process start.
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token"
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

// codex-rs refreshes the ChatGPT tokens once last_refresh is this old
// (TOKEN_REFRESH_INTERVAL = 8 days in login/src/auth/manager.rs).
const TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1_000

export type CodexLogin =
  | {
      readonly kind: "chatgpt"
      readonly accessToken: string
      readonly refreshToken: string
      readonly accountId: string | undefined
      readonly lastRefresh: string | undefined
    }
  | { readonly kind: "apiKey"; readonly apiKey: string }

export function defaultCodexAuthPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")
}

// Returns undefined only when the login file does not exist; unreadable
// (EACCES) or malformed content throws so a real problem surfaces instead of
// silently disabling the provider.
export async function readCodexLogin(input?: {
  readonly path?: string
}): Promise<CodexLogin | undefined> {
  const path = input?.path ?? defaultCodexAuthPath()
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined
    }
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new Error(`Codex login at ${path} is malformed.`)
  }
  if (isRecord(parsed.tokens) && isString(parsed.tokens.access_token)) {
    if (!isString(parsed.tokens.refresh_token)) {
      throw new Error(
        `Codex login at ${path} holds tokens without a refresh token.`,
      )
    }
    return {
      kind: "chatgpt",
      accessToken: parsed.tokens.access_token,
      refreshToken: parsed.tokens.refresh_token,
      accountId: isString(parsed.tokens.account_id)
        ? parsed.tokens.account_id
        : undefined,
      lastRefresh: isString(parsed.last_refresh)
        ? parsed.last_refresh
        : undefined,
    }
  }
  if (isString(parsed.OPENAI_API_KEY)) {
    return { kind: "apiKey", apiKey: parsed.OPENAI_API_KEY }
  }
  throw new Error(
    `Codex login at ${path} holds no tokens. Run \`codex\` and log in first.`,
  )
}

export type CodexAccessToken = {
  readonly accessToken: string
  readonly accountId: string | undefined
}

// Returns a valid ChatGPT access token, refreshing in memory when the stored
// login is stale by the codex-rs weekly policy.
export async function resolveCodexAccessToken(input?: {
  readonly path?: string
  readonly now?: () => number
  readonly fetchFn?: typeof fetch
}): Promise<CodexAccessToken> {
  const path = input?.path ?? defaultCodexAuthPath()
  const login = await readCodexLogin({ path })
  if (login === undefined) {
    throw new Error(
      `Codex login not found at ${path}. Run \`codex\` and log in first.`,
    )
  }
  if (login.kind === "apiKey") {
    throw new Error(
      `Codex login at ${path} is an API-key login, not a ChatGPT login.`,
    )
  }
  const now = input?.now ?? Date.now
  if (!isStale(login.lastRefresh, now())) {
    return { accessToken: login.accessToken, accountId: login.accountId }
  }
  const refreshed = await refreshTokens(
    login.refreshToken,
    input?.fetchFn ?? fetch,
  )
  return { accessToken: refreshed, accountId: login.accountId }
}

function isStale(lastRefresh: string | undefined, nowMs: number): boolean {
  if (lastRefresh === undefined) return true
  const at = Date.parse(lastRefresh)
  if (Number.isNaN(at)) return true
  return nowMs - at >= TOKEN_REFRESH_INTERVAL_MS
}

async function refreshTokens(
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const response = await fetchFn(REFRESH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Bounded wait: a hung auth endpoint must not stall the Turn start.
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  })
  if (!response.ok) {
    // The error body can quote request data; report the status only so token
    // material never reaches logs.
    throw new Error(
      `Codex token refresh failed with HTTP ${response.status}. Run \`codex\` and log in again if this persists.`,
    )
  }
  const body: unknown = await response.json()
  if (!isRecord(body) || !isString(body.access_token)) {
    throw new Error("Codex token refresh returned no access token.")
  }
  return body.access_token
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}
