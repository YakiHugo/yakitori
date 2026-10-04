import { mkdtemp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createCodexAuthProvider,
  defaultCodexAuthPath,
  readCodexLogin,
} from "../runtime/codex-credentials.ts"
import { resolveGrokCredentials } from "../runtime/grok-credentials.ts"
import { ConfigurationError } from "./config-errors.ts"

// File imports have their own credential owner. Sharing a copied refresh token
// with the source CLI would let two independent files rotate the same login.
// Existing local logins continue to use the CLI's original credential file.
export function createSubscriptionAccountStore(
  directory: string,
  fetchFn: typeof fetch = fetch,
) {
  const importedPath = join(directory, "codex.json")
  return {
    async codexPath(): Promise<string> {
      try {
        await stat(importedPath)
        return importedPath
      } catch (cause) {
        if (!isMissing(cause)) throw cause
        return defaultCodexAuthPath()
      }
    },
    async importAccount(id: "codex" | "grok", text?: string): Promise<void> {
      if (id === "grok") {
        if (text !== undefined)
          throw new ConfigurationError("Grok uses its local CLI account.")
        try {
          await resolveGrokCredentials()
        } catch (cause) {
          if (cause instanceof SyntaxError)
            throw new ConfigurationError(
              "The Grok account file is invalid JSON.",
            )
          if (
            !(cause instanceof Error) ||
            !/^Grok |^The Grok CLI/.test(cause.message)
          )
            throw cause
          throw new ConfigurationError(cause.message)
        }
        return
      }
      if (text === undefined) {
        let login: Awaited<ReturnType<typeof readCodexLogin>>
        try {
          login = await readCodexLogin()
        } catch (cause) {
          if (cause instanceof SyntaxError)
            throw new ConfigurationError(
              "The Codex account file is invalid JSON.",
            )
          if (
            !(cause instanceof Error) ||
            !cause.message.startsWith("Codex login at ")
          )
            throw cause
          throw new ConfigurationError(cause.message)
        }
        if (login === undefined)
          throw new ConfigurationError(
            `No ChatGPT account found at ${defaultCodexAuthPath()}. Sign in or choose an account file.`,
          )
        if (login.kind !== "chatgpt")
          throw new ConfigurationError(
            "Codex is signed in with an API key. Add it under OpenAI, or sign in with a ChatGPT account.",
          )
        await rm(importedPath, { force: true })
        return
      }
      const document = accountDocument(text)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const staging = await mkdtemp(join(directory, ".import-"))
      const path = join(staging, "auth.json")
      try {
        await writeFile(path, JSON.stringify(document), { mode: 0o600 })
        // Match Magpie's import contract: validate with the vendor and keep the
        // rotated credentials, rather than claiming success from JSON alone.
        await createCodexAuthProvider({
          path,
          async fetchFn(url, init) {
            let response: Response
            try {
              response = await fetchFn(url, init)
            } catch (cause) {
              if (
                cause instanceof TypeError ||
                (cause instanceof DOMException && cause.name === "TimeoutError")
              )
                throw new ConfigurationError(
                  "Could not reach ChatGPT. Check your connection and try importing again.",
                )
              throw cause
            }
            if (!response.ok)
              throw new ConfigurationError(
                `ChatGPT rejected the account (HTTP ${response.status}). Sign in again or choose a fresh account export.`,
              )
            return response
          },
        }).resolve({
          forceRefresh: true,
        })
        await rename(path, importedPath)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    },
  }
}

function accountDocument(text: string) {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause
    // JSON.parse errors can include a fragment of the submitted secret.
    throw new ConfigurationError("The account file is invalid JSON.")
  }
  if (!isRecord(value))
    throw new ConfigurationError(
      "Choose a Codex auth.json or a ChatGPT account export.",
    )
  const tokens = isRecord(value.tokens) ? value.tokens : value
  if (
    typeof tokens.access_token !== "string" ||
    !tokens.access_token.trim() ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token.trim()
  )
    throw new ConfigurationError(
      "The account file needs ChatGPT access and refresh tokens. API keys belong under OpenAI.",
    )
  return {
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(typeof tokens.account_id === "string"
        ? { account_id: tokens.account_id }
        : {}),
      ...(typeof tokens.id_token === "string"
        ? { id_token: tokens.id_token }
        : {}),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(value: unknown) {
  return value instanceof Error && "code" in value && value.code === "ENOENT"
}
