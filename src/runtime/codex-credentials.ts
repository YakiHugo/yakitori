import { createHash, randomUUID } from "node:crypto"
import { open, readFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { flock } from "fs-ext"

// ChatGPT OAuth login shared with the official codex CLI
// (~/.codex/auth.json, or $CODEX_HOME/auth.json). Refresh consumes a rotating
// token, so the provider persists the replacement token and last_refresh just
// as Codex does; a file lock serializes Yakitori refreshers across processes.
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token"
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
// One refresh request is bounded to 15 s. Twice that window lets a competing
// Yakitori process finish its network call and atomic write without allowing a
// dead owner to stall Turn admission indefinitely.
const AUTH_LOCK_TIMEOUT_MS = 30_000
const AUTH_LOCK_POLL_MS = 25

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
  const parsed = await readCodexAuthDocument(path)
  return parsed === undefined ? undefined : parseCodexLogin(parsed, path)
}

async function readCodexAuthDocument(
  path: string,
): Promise<Record<string, unknown> | undefined> {
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
  return parsed
}

function parseCodexLogin(
  parsed: Record<string, unknown>,
  path: string,
): CodexLogin {
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

export type CodexAuthProvider = {
  resolve(input?: {
    readonly forceRefresh?: boolean
  }): Promise<CodexAccessToken>
  invalidate(): void
}

// Provider-scoped live auth owner. It re-reads the shared login before each
// request so CLI rotations are observed. Stale refreshes are single-flight in
// process, file-locked across Yakitori processes, guarded by account identity,
// and persisted before the replacement access token becomes usable.
export function createCodexAuthProvider(input?: {
  readonly path?: string
  readonly now?: () => number
  readonly fetchFn?: typeof fetch
}): CodexAuthProvider {
  const path = input?.path ?? defaultCodexAuthPath()
  const now = input?.now ?? Date.now
  const fetchFn = input?.fetchFn ?? fetch
  let accessInvalidated = false
  let inFlight:
    | Readonly<{ sourceKey: string; promise: Promise<CodexAccessToken> }>
    | undefined

  return {
    async resolve(options) {
      const login = await requireChatGptLogin(path)
      const nextSourceKey = credentialSourceKey(login)
      if (
        !options?.forceRefresh &&
        !accessInvalidated &&
        !isStale(login.lastRefresh, now())
      ) {
        return { accessToken: login.accessToken, accountId: login.accountId }
      }
      if (inFlight?.sourceKey === nextSourceKey) return inFlight.promise

      const promise = refreshAndPersistTokens({
        path,
        expectedSourceKey: nextSourceKey,
        expectedAccountId: login.accountId,
        fetchFn,
        nowMs: now(),
      }).then((token) => {
        accessInvalidated = false
        return token
      })
      inFlight = { sourceKey: nextSourceKey, promise }
      try {
        return await promise
      } finally {
        if (inFlight?.promise === promise) inFlight = undefined
      }
    },
    invalidate() {
      accessInvalidated = true
    },
  }
}

// Returns a valid ChatGPT access token, refreshing and persisting the shared
// login when it is stale by the codex-rs weekly policy.
export async function resolveCodexAccessToken(input?: {
  readonly path?: string
  readonly now?: () => number
  readonly fetchFn?: typeof fetch
}): Promise<CodexAccessToken> {
  const path = input?.path ?? defaultCodexAuthPath()
  return createCodexAuthProvider({
    path,
    ...(input?.now === undefined ? {} : { now: input.now }),
    ...(input?.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
  }).resolve()
}

async function requireChatGptLogin(path: string) {
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
  return login
}

function credentialSourceKey(
  login: Extract<CodexLogin, { readonly kind: "chatgpt" }>,
): string {
  return createHash("sha256")
    .update(login.accessToken)
    .update("\0")
    .update(login.refreshToken)
    .update("\0")
    .update(login.accountId ?? "")
    .update("\0")
    .update(login.lastRefresh ?? "")
    .digest("hex")
}

function isStale(lastRefresh: string | undefined, nowMs: number): boolean {
  if (lastRefresh === undefined) return true
  const at = Date.parse(lastRefresh)
  if (Number.isNaN(at)) return true
  return nowMs - at >= TOKEN_REFRESH_INTERVAL_MS
}

async function refreshAndPersistTokens(input: {
  readonly path: string
  readonly expectedSourceKey: string
  readonly expectedAccountId: string | undefined
  readonly fetchFn: typeof fetch
  readonly nowMs: number
}): Promise<CodexAccessToken> {
  return withCodexAuthLock(input.path, async () => {
    const beforeRefresh = await requireChatGptLogin(input.path)
    const beforeSourceKey = credentialSourceKey(beforeRefresh)
    if (beforeSourceKey !== input.expectedSourceKey) {
      return guardedReload(beforeRefresh, input.expectedAccountId)
    }

    const tokens = await refreshTokens(
      beforeRefresh.refreshToken,
      input.fetchFn,
    )
    const document = await readCodexAuthDocument(input.path)
    if (document === undefined) {
      throw new Error(
        `Codex login disappeared while credentials were refreshing.`,
      )
    }
    const afterRefresh = parseCodexLogin(document, input.path)
    if (afterRefresh.kind !== "chatgpt") {
      throw new Error(
        "Codex login changed type while credentials were refreshing.",
      )
    }
    if (credentialSourceKey(afterRefresh) !== beforeSourceKey) {
      return guardedReload(afterRefresh, input.expectedAccountId)
    }

    await persistRefreshedTokens(input.path, document, tokens, input.nowMs)
    return {
      accessToken: tokens.accessToken,
      accountId: afterRefresh.accountId,
    }
  })
}

function guardedReload(
  login: Extract<CodexLogin, { readonly kind: "chatgpt" }>,
  expectedAccountId: string | undefined,
): CodexAccessToken {
  if (
    expectedAccountId === undefined ||
    login.accountId !== expectedAccountId
  ) {
    throw new Error("Codex login changed while credentials were refreshing.")
  }
  return { accessToken: login.accessToken, accountId: login.accountId }
}

async function persistRefreshedTokens(
  path: string,
  document: Record<string, unknown>,
  tokens: RefreshedTokens,
  nowMs: number,
): Promise<void> {
  if (!isRecord(document.tokens)) {
    throw new Error(`Codex login at ${path} holds no token record.`)
  }
  if (tokens.idToken !== undefined) validateChatGptIdToken(tokens.idToken)
  const updated = {
    ...document,
    tokens: {
      ...document.tokens,
      access_token: tokens.accessToken,
      ...(tokens.refreshToken === undefined
        ? {}
        : { refresh_token: tokens.refreshToken }),
      ...(tokens.idToken === undefined ? {} : { id_token: tokens.idToken }),
    },
    last_refresh: new Date(nowMs).toISOString(),
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const file = await open(temporaryPath, "wx", 0o600)
    try {
      await file.writeFile(`${JSON.stringify(updated, null, 2)}\n`, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporaryPath, path)
    const directory = await open(dirname(path), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function validateChatGptIdToken(idToken: string): void {
  const parts = idToken.split(".")
  if (
    parts.length !== 3 ||
    parts.some((part) => part.length === 0) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? "")
  ) {
    throw new Error("Codex token refresh returned an invalid ID token.")
  }
  try {
    const encodedPayload = parts[1] ?? ""
    const payload = Buffer.from(encodedPayload, "base64url")
    if (payload.toString("base64url") !== encodedPayload) {
      throw new Error("non-canonical base64url")
    }
    const claims: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
    )
    if (!isRecord(claims)) throw new Error("non-object claims")
    validateOptionalClaim(claims.email, "string")
    validateOptionalClaimRecord(claims["https://api.openai.com/profile"], [
      ["email", "string"],
    ])
    validateOptionalClaimRecord(claims["https://api.openai.com/auth"], [
      ["chatgpt_plan_type", "string"],
      ["chatgpt_user_id", "string"],
      ["user_id", "string"],
      ["chatgpt_account_id", "string"],
      ["chatgpt_account_is_fedramp", "boolean", false],
    ])
  } catch {
    throw new Error("Codex token refresh returned an invalid ID token.")
  }
}

function validateOptionalClaim(
  value: unknown,
  type: "boolean" | "string",
  allowNull = true,
): void {
  if (
    value !== undefined &&
    !(allowNull && value === null) &&
    typeof value !== type
  ) {
    throw new Error("invalid claim")
  }
}

function validateOptionalClaimRecord(
  value: unknown,
  properties: readonly (readonly [string, "boolean" | "string", boolean?])[],
): void {
  if (value === undefined || value === null) return
  if (!isRecord(value)) throw new Error("invalid claim object")
  for (const [key, type, allowNull] of properties) {
    validateOptionalClaim(value[key], type, allowNull)
  }
}

async function withCodexAuthLock<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const lock = await open(`${path}.yakitori.lock`, "a+", 0o600)
  try {
    await acquireCodexAuthLock(lock.fd)
    try {
      return await run()
    } finally {
      await flockPromise(lock.fd, "un")
    }
  } finally {
    await lock.close()
  }
}

async function acquireCodexAuthLock(fileDescriptor: number): Promise<void> {
  const deadline = Date.now() + AUTH_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await flockPromise(fileDescriptor, "exnb")
      return
    } catch (error) {
      if (!isLockConflict(error)) throw error
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${AUTH_LOCK_TIMEOUT_MS} ms waiting for the Codex credential refresh lock.`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, AUTH_LOCK_POLL_MS))
    }
  }
}

function flockPromise(
  fileDescriptor: number,
  operation: "exnb" | "un",
): Promise<void> {
  return new Promise((resolve, reject) => {
    flock(fileDescriptor, operation, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

function isLockConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EAGAIN" ||
      (error as NodeJS.ErrnoException).code === "EWOULDBLOCK")
  )
}

type RefreshedTokens = Readonly<{
  accessToken: string
  refreshToken?: string
  idToken?: string
}>

async function refreshTokens(
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<RefreshedTokens> {
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
  return {
    accessToken: body.access_token,
    ...(isString(body.refresh_token)
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(isString(body.id_token) ? { idToken: body.id_token } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}
