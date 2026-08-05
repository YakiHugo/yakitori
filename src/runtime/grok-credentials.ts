import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// xAI subscription credentials, shared read-only with the official Grok CLI
// (~/.grok/auth.json). We deliberately do not refresh or write this file:
// the CLI refreshes it itself, and concurrent refreshes of a shared
// refresh-token file can lose rotated tokens or get the token family revoked.
// When the token expires, re-run `grok` and log in again.
export const GROK_API_BASE_URL = "https://api.x.ai/v1"

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
  const path = options.path ?? defaultGrokCredentialsPath()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const credentials = await readGrokCredentials(path)
  if (credentials.expiresAt - now() <= EXPIRY_MARGIN_SECONDS) {
    throw new Error(
      "The Grok CLI login has expired. Run `grok` and log in again, or set XAI_API_KEY.",
    )
  }
  return credentials.accessToken
}

type GrokCredentials = {
  readonly accessToken: string
  readonly expiresAt: number
}

async function readGrokCredentials(path: string): Promise<GrokCredentials> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(
      `Grok credentials not found at ${path}. Run \`grok\` and log in first, or set XAI_API_KEY.`,
    )
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Grok credentials at ${path} are malformed.`)
  }
  const entry = Object.values(parsed).find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).key === "string" &&
      typeof (value as Record<string, unknown>).expires_at === "string",
  ) as Record<string, unknown> | undefined
  if (entry === undefined) {
    throw new Error(
      `Grok credentials at ${path} hold no login. Run \`grok\` and log in first.`,
    )
  }
  const expiresAt = Math.floor(Date.parse(entry.expires_at as string) / 1000)
  if (Number.isNaN(expiresAt)) {
    throw new Error(`Grok credentials at ${path} carry a bad expires_at.`)
  }
  return { accessToken: entry.key as string, expiresAt }
}
