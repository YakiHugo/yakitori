import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { dirname, join } from "node:path"
import {
  auth,
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import {
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { McpServerConfig } from "./mcp-config.ts"

type RemoteConfig = Extract<McpServerConfig, { url: string }>
type Credentials = {
  redirectUrl?: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  expiresAt?: number
}
type PendingLogin = {
  server: Server
  state: string
  verifier?: string
  authorizationUrl?: string
  resolve(): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
  cancellation: AbortController
  operation?: Promise<unknown>
  exchanging?: boolean
}
type Entry = {
  config: RemoteConfig
  path: string
  credentials: Promise<Credentials>
  writes: Promise<void>
  provider: OAuthClientProvider
  rawProvider: OAuthClientProvider
  pending?: PendingLogin
  refreshing?: Promise<void>
  starting?: boolean
  loginEpoch: number
}

export type McpOAuthLogin = Readonly<{
  authorizationUrl: string
  completion: Promise<void>
}>

export type McpOAuth = Readonly<{
  provider(
    name: string,
    config: McpServerConfig,
  ): OAuthClientProvider | undefined
  startLogin(name: string, config: McpServerConfig): Promise<McpOAuthLogin>
  logout(name: string, config: McpServerConfig): Promise<void>
  hasCredentials(name: string, config: McpServerConfig): Promise<boolean>
  close(): Promise<void>
}>

// Codex owns a temporary loopback callback for each explicit login. The SDK
// owns discovery, dynamic registration, PKCE and refresh; this module owns the
// user gesture, callback lifetime, and durable credentials.
export function createMcpOAuth(
  options: Readonly<{ storePath: string }>,
): McpOAuth {
  const entries = new Map<string, Entry>()
  let closed = false
  const fetchOAuth: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      redirect: "error",
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    })
  const get = (name: string, config: McpServerConfig): Entry => {
    if (closed) throw new Error("MCP OAuth is closed.")
    if (!("url" in config))
      throw new Error("MCP OAuth requires an HTTP server.")
    const key = createHash("sha256")
      .update(JSON.stringify([name, config.url, config.oauth ?? null]))
      .digest("hex")
    const existing = entries.get(key)
    if (existing) return existing
    const path = join(options.storePath, `${key}.json`)
    const credentials = readCredentials(path)
    const save = async (mutate: (value: Credentials) => void) => {
      const write = entry.writes.then(async () => {
        const current = await credentials
        const next = { ...current }
        mutate(next)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify(next), {
            mode: 0o600,
            flag: "wx",
          })
          await rename(temporary, path)
          for (const key of Object.keys(current) as (keyof Credentials)[])
            delete current[key]
          Object.assign(current, next)
        } finally {
          await rm(temporary, { force: true })
        }
      })
      entry.writes = write.catch(() => {})
      await write
    }
    const rawProvider: OAuthClientProvider = {
      get redirectUrl() {
        return redirectUrl
      },
      get clientMetadata() {
        return {
          client_name: "Yakitori",
          redirect_uris: [redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: config.oauth?.clientSecretEnvVar
            ? "client_secret_post"
            : "none",
          ...(config.oauth?.scopes === undefined
            ? {}
            : { scope: config.oauth.scopes.join(" ") }),
        }
      },
      state() {
        if (!entry.pending)
          throw new UnauthorizedError("MCP login is required.")
        return entry.pending.state
      },
      async clientInformation() {
        const current = await credentials
        redirectUrl = current.redirectUrl ?? redirectUrl
        if (config.oauth?.clientId !== undefined) {
          const variable = config.oauth.clientSecretEnvVar
          const secret =
            variable === undefined ? undefined : process.env[variable]
          if (variable !== undefined && secret === undefined)
            throw new Error(
              `MCP OAuth client secret environment variable ${variable} is not set.`,
            )
          return {
            client_id: config.oauth.clientId,
            ...(secret === undefined ? {} : { client_secret: secret }),
          }
        }
        if (current.client === undefined && entry.pending === undefined)
          throw new UnauthorizedError("MCP login is required.")
        return current.client
      },
      saveClientInformation: (client) =>
        save((current) => {
          current.client = client
        }),
      async tokens() {
        return (await credentials).tokens
      },
      saveTokens: (tokens) =>
        save((current) => {
          current.tokens = tokens
          if (tokens.expires_in !== undefined)
            current.expiresAt = Date.now() + tokens.expires_in * 1_000
          else delete current.expiresAt
        }),
      redirectToAuthorization(url) {
        if (!entry.pending)
          throw new UnauthorizedError("MCP login is required.")
        entry.pending.authorizationUrl = url.href
      },
      saveCodeVerifier(verifier) {
        if (!entry.pending)
          throw new UnauthorizedError("MCP login is required.")
        entry.pending.verifier = verifier
      },
      codeVerifier() {
        if (!entry.pending?.verifier)
          throw new UnauthorizedError("MCP login has expired.")
        return entry.pending.verifier
      },
      invalidateCredentials: (scope) =>
        save((current) => {
          if (scope === "all" || scope === "client") delete current.client
          if (scope === "all" || scope === "tokens") {
            delete current.tokens
            delete current.expiresAt
          }
          if ((scope === "all" || scope === "verifier") && entry.pending)
            delete entry.pending.verifier
        }),
    }
    // A placeholder is used only before an explicit login. No redirect is ever
    // launched implicitly when background startup discovers a protected server.
    let redirectUrl = "http://127.0.0.1/callback"
    const provider: OAuthClientProvider = {
      ...rawProvider,
      get redirectUrl() {
        return rawProvider.redirectUrl
      },
      get clientMetadata() {
        return rawProvider.clientMetadata
      },
      async tokens() {
        const current = await credentials
        if (
          current.tokens &&
          current.expiresAt !== undefined &&
          current.expiresAt <= Date.now()
        ) {
          entry.refreshing ??= auth(rawProvider, {
            serverUrl: config.url,
            fetchFn: fetchOAuth,
          })
            .then((result) => {
              if (result !== "AUTHORIZED")
                throw new UnauthorizedError("MCP login is required.")
            })
            .finally(() => {
              delete entry.refreshing
            })
          await entry.refreshing
        }
        return current.tokens
      },
    }
    const entry: Entry = {
      config,
      path,
      credentials,
      writes: Promise.resolve(),
      provider,
      rawProvider,
      loginEpoch: 0,
    }
    entries.set(key, entry)
    return entry
  }
  const finish = (entry: Entry, error?: unknown) => {
    const pending = entry.pending
    if (!pending) return
    delete entry.pending
    clearTimeout(pending.timer)
    pending.cancellation.abort()
    pending.server.close()
    pending.server.closeAllConnections()
    if (error === undefined) pending.resolve()
    else pending.reject(error)
  }
  return {
    provider(name, config) {
      if (
        !("url" in config) ||
        config.bearerTokenEnvVar !== undefined ||
        Object.keys(config.httpHeaders ?? {}).some(
          (key) => key.toLowerCase() === "authorization",
        ) ||
        Object.keys(config.envHttpHeaders ?? {}).some(
          (key) => key.toLowerCase() === "authorization",
        )
      )
        return undefined
      return get(name, config).provider
    },
    async startLogin(name, config) {
      const entry = get(name, config)
      if (entry.pending || entry.starting)
        throw new Error(`MCP login is already pending for ${name}.`)
      entry.starting = true
      const epoch = ++entry.loginEpoch
      try {
        await entry.refreshing
      } catch (error) {
        delete entry.starting
        throw new Error("MCP OAuth login failed.", { cause: error })
      }
      if (closed || epoch !== entry.loginEpoch) {
        delete entry.starting
        throw new Error("MCP login cancelled.")
      }
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const completion = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      })
      // Completion is deliberately exposed to the parent; also mark it handled
      // until the caller has received the authorization URL and can observe it.
      void completion.catch(() => {})
      const state = randomBytes(32).toString("base64url")
      const cancellation = new AbortController()
      const loginFetch: typeof fetch = (input, init) =>
        fetchOAuth(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, cancellation.signal])
            : cancellation.signal,
        })
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        if (request.method !== "GET" || url.pathname !== "/callback") {
          response.writeHead(404).end()
          return
        }
        const received = Buffer.from(url.searchParams.get("state") ?? "")
        const expected = Buffer.from(state)
        if (
          entry.pending?.state !== state ||
          received.length !== expected.length ||
          !timingSafeEqual(received, expected)
        ) {
          response.writeHead(400).end("Invalid OAuth state.")
          return
        }
        if (entry.pending.exchanging) {
          response
            .writeHead(409)
            .end("MCP authorization is already completing.")
          return
        }
        const code = url.searchParams.get("code")
        if (!code || url.searchParams.has("error")) {
          response.writeHead(400).end("MCP authorization was denied.")
          finish(entry, new Error("MCP authorization was denied."))
          return
        }
        entry.pending.exchanging = true
        entry.pending.operation = auth(entry.rawProvider, {
          serverUrl: entry.config.url,
          authorizationCode: code,
          fetchFn: loginFetch,
        })
          .then((result) => {
            if (result !== "AUTHORIZED")
              throw new Error("MCP authorization did not complete.")
            response
              .writeHead(200, {
                "Content-Type": "text/plain",
                "Cache-Control": "no-store",
              })
              .end("MCP connected. You can return to Yakitori.")
            finish(entry)
          })
          .catch((error: unknown) => {
            response
              .writeHead(400)
              .end("MCP authorization failed. Return to Yakitori for details.")
            finish(
              entry,
              new Error("MCP OAuth authorization failed.", { cause: error }),
            )
          })
      })
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen)
        server.listen(0, "127.0.0.1", () => {
          server.off("error", rejectListen)
          resolveListen()
        })
      }).finally(() => {
        delete entry.starting
      })
      if (closed || epoch !== entry.loginEpoch) {
        server.close()
        throw new Error("MCP login cancelled.")
      }
      const address = server.address()
      if (!address || typeof address === "string")
        throw new Error("MCP OAuth callback listener has no address.")
      // Bound abandoned loopback listeners and their in-memory PKCE verifiers.
      const timer = setTimeout(
        () => finish(entry, new Error("MCP login timed out.")),
        5 * 60_000,
      )
      timer.unref()
      entry.pending = { server, state, resolve, reject, timer, cancellation }
      try {
        const current = await entry.credentials
        cancellation.signal.throwIfAborted()
        const redirectUrl = `http://127.0.0.1:${address.port}/callback`
        // Dynamic registration binds redirect URIs, so a new loopback port
        // requires registration again. Pre-registered client IDs remain config.
        if (current.redirectUrl !== redirectUrl) delete current.client
        current.redirectUrl = redirectUrl
        delete current.tokens
        delete current.expiresAt
        await entry.rawProvider.clientInformation()
        cancellation.signal.throwIfAborted()
        const operation = auth(entry.rawProvider, {
          serverUrl: entry.config.url,
          fetchFn: loginFetch,
          ...(entry.config.oauth?.scopes === undefined
            ? {}
            : { scope: entry.config.oauth.scopes.join(" ") }),
        })
        entry.pending.operation = operation
        await operation
        const authorizationUrl = entry.pending?.authorizationUrl
        if (!authorizationUrl)
          throw new Error("MCP server did not return an authorization URL.")
        return { authorizationUrl, completion }
      } catch (error) {
        const failure = new Error("MCP OAuth login failed.", { cause: error })
        finish(entry, failure)
        throw failure
      }
    },
    async logout(name, config) {
      const entry = get(name, config)
      entry.loginEpoch++
      const operation = entry.pending?.operation
      finish(entry, new Error("MCP login cancelled."))
      if (operation) await Promise.allSettled([operation])
      if (entry.refreshing) await Promise.allSettled([entry.refreshing])
      await entry.writes
      await entry.rawProvider.invalidateCredentials?.("all")
      await rm(entry.path, { force: true })
    },
    async hasCredentials(name, config) {
      if (!("url" in config)) return false
      return (await get(name, config).credentials).tokens !== undefined
    },
    async close() {
      closed = true
      const operations = [...entries.values()].flatMap((entry) =>
        entry.pending?.operation ? [entry.pending.operation] : [],
      )
      for (const entry of entries.values())
        finish(entry, new Error("MCP OAuth closed."))
      await Promise.allSettled(operations)
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          await entry.refreshing
          await entry.writes
        }),
      )
    },
  }
}

async function readCredentials(path: string): Promise<Credentials> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {}
    throw error
  }
  const value: unknown = JSON.parse(raw)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid MCP OAuth credentials.")
  return {
    ...("redirectUrl" in value && typeof value.redirectUrl === "string"
      ? { redirectUrl: value.redirectUrl }
      : {}),
    ...("client" in value
      ? { client: OAuthClientInformationSchema.parse(value.client) }
      : {}),
    ...("tokens" in value
      ? { tokens: OAuthTokensSchema.parse(value.tokens) }
      : {}),
    ...("expiresAt" in value && typeof value.expiresAt === "number"
      ? { expiresAt: value.expiresAt }
      : {}),
  }
}
