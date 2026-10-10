import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// xAI subscription credentials, shared read-only with the official Grok CLI
// (~/.grok/auth.json). We deliberately do not refresh or write this file:
// the CLI refreshes it itself, and concurrent refreshes of a shared
// refresh-token file can lose rotated tokens or get the token family revoked.
// When the token expires, re-run `grok` and log in again.
export const GROK_API_BASE_URL = "https://api.x.ai/v1"

// Yakitori targets the public xAI API, so select the official CLI's production
// issuer/client scope rather than an unrelated enterprise login in auth.json.
const GROK_AUTH_SCOPE =
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"

// Treat tokens this close to expiry as unusable, so a long model call never
// starts with a nearly-stale token.
const EXPIRY_MARGIN_SECONDS = 120

export type GrokCredentialsOptions = {
  readonly path?: string
  readonly now?: () => number
}

export function defaultGrokCredentialsPath(): string {
  return process.env.GROK_CREDENTIALS ?? join(homedir(), ".grok", "auth.json")
}

// Returns the stored access token when it is fresh enough to use.
export async function resolveGrokAccessToken(
  options: GrokCredentialsOptions = {},
): Promise<string> {
  return (await resolveStoredGrokCredentials(options)).accessToken
}

// Read credential and owner together so a concurrent CLI token rotation cannot
// associate one account's token with another account's continuation history.
export async function resolveGrokModelCredentials(
  options: GrokCredentialsOptions = {},
): Promise<Readonly<{ accessToken: string; ownerIdentity: string }>> {
  const credentials = await resolveStoredGrokCredentials(options)
  return {
    accessToken: credentials.accessToken,
    ownerIdentity:
      credentials.userId === undefined
        ? `token:${credentials.accessToken}`
        : `account:${credentials.userId}`,
  }
}

export async function resolveGrokCredentials(
  options: GrokCredentialsOptions = {},
): Promise<
  Readonly<{
    accessToken: string
    userId: string
    expiresAt: number
  }>
> {
  const credentials = await resolveStoredGrokCredentials(options)
  if (credentials.userId === undefined) {
    throw new Error(
      "The Grok CLI login has no user identity. Run `grok` and log in again.",
    )
  }
  return {
    accessToken: credentials.accessToken,
    userId: credentials.userId,
    expiresAt: credentials.expiresAt,
  }
}

// Account identity for scoping cached per-account data (the model catalog),
// following the same credential source as discovery: the XAI_API_KEY
// environment key when set, otherwise the CLI login. Old logins without a
// user id fall back to a token digest and simply rescope when tokens rotate.
export async function resolveGrokAccountIdentity(
  options: GrokCredentialsOptions = {},
): Promise<string | undefined> {
  const envKey = process.env.XAI_API_KEY
  if (envKey !== undefined) {
    return createHash("sha256").update(envKey).digest("hex")
  }
  const credentials = await readGrokCredentials(
    options.path ?? defaultGrokCredentialsPath(),
  )
  return (
    credentials.userId ??
    createHash("sha256").update(credentials.accessToken).digest("hex")
  )
}

async function resolveStoredGrokCredentials(
  options: GrokCredentialsOptions,
): Promise<GrokCredentials> {
  const path = options.path ?? defaultGrokCredentialsPath()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const credentials = await readGrokCredentials(path)
  if (credentials.expiresAt - now() <= EXPIRY_MARGIN_SECONDS) {
    throw new Error(
      "The Grok CLI login has expired. Run `grok` and log in again, or set XAI_API_KEY.",
    )
  }
  return credentials
}

type GrokCredentials = {
  readonly accessToken: string
  readonly expiresAt: number
  readonly userId: string | undefined
}

async function readGrokCredentials(path: string): Promise<GrokCredentials> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      cause.code !== "ENOENT"
    )
      throw cause
    throw new Error(
      `Grok credentials not found at ${path}. Run \`grok\` and log in first, or set XAI_API_KEY.`,
    )
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Grok credentials at ${path} are malformed.`)
  }
  const entry = (parsed as Record<string, unknown>)[GROK_AUTH_SCOPE]
  if (entry === undefined) {
    throw new Error(
      `Grok credentials at ${path} hold no login. Run \`grok\` and log in first.`,
    )
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`Grok credentials at ${path} carry a malformed xAI login.`)
  }
  const {
    key,
    expires_at: expiresAtValue,
    user_id: userId,
  } = entry as Record<string, unknown>
  if (
    typeof key !== "string" ||
    key.trim() === "" ||
    typeof expiresAtValue !== "string"
  ) {
    throw new Error(`Grok credentials at ${path} carry a malformed xAI login.`)
  }
  const expiresAt = Math.floor(Date.parse(expiresAtValue) / 1000)
  if (Number.isNaN(expiresAt)) {
    throw new Error(`Grok credentials at ${path} carry a bad expires_at.`)
  }
  return {
    accessToken: key,
    expiresAt,
    userId:
      typeof userId === "string" && userId.trim() !== "" ? userId : undefined,
  }
}
