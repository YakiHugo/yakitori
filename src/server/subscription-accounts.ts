import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createCodexAuthProvider,
  defaultCodexAuthPath,
  readCodexLogin,
} from "../runtime/codex-credentials.ts"
import {
  defaultGrokCredentialsPath,
  resolveGrokCredentials,
} from "../runtime/grok-credentials.ts"
import { LoginRequiredError } from "../runtime/login-required.ts"
import { ConfigurationError } from "./config-errors.ts"

// File imports have their own credential owner. Sharing a copied refresh token
// with the source CLI would let two independent files rotate the same login.
// Existing local logins continue to use the CLI's original credential file.
export function createSubscriptionAccountStore(
  directory: string,
  fetchFn: typeof fetch = fetch,
) {
  return {
    async importAccount(id: "codex" | "grok", text?: string) {
      if (id === "grok") {
        if (text !== undefined)
          throw new ConfigurationError("Grok uses its local CLI account.")
        const credentials = await resolveGrokCredentials()
        return {
          credentialPath: defaultGrokCredentialsPath(),
          credentialOwner: `account:${credentials.userId}`,
        }
      }
      if (text === undefined) {
        const login = await readCodexLogin()
        if (login === undefined)
          throw new LoginRequiredError(
            `No ChatGPT account found at ${defaultCodexAuthPath()}. Sign in or choose an account file.`,
          )
        if (login.kind !== "chatgpt")
          throw new LoginRequiredError(
            "Codex is signed in with an API key. Add it under OpenAI, or sign in with a ChatGPT account.",
          )
        const resolved = await createCodexAuthProvider({
          path: defaultCodexAuthPath(),
          fetchFn,
        }).resolve()
        const credentialOwner = resolved.accountId
        if (!credentialOwner)
          throw new LoginRequiredError("The Codex account has no identity.")
        return { credentialPath: defaultCodexAuthPath(), credentialOwner }
      }
      const document = accountDocument(text)
      const importedPath = join(directory, `codex_${randomUUID()}.json`)
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
        const credentialOwner = await readCodexLogin({ path })
        if (credentialOwner?.kind !== "chatgpt" || !credentialOwner.accountId)
          throw new ConfigurationError(
            "The imported account has no stable account identity.",
          )
        const ownerIdentity = credentialOwner.accountId
        await rename(path, importedPath)
        return { credentialPath: importedPath, credentialOwner: ownerIdentity }
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
