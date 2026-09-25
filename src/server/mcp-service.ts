import type {
  McpConnectionManager,
  McpServerConfig,
} from "../runtime/mcp-connection-manager.ts"
import type { McpOAuth } from "../runtime/mcp-oauth.ts"

export type McpServerSummary = Readonly<{
  name: string
  transport: "stdio" | "http"
  enabled: boolean
  state: "ready" | "stopped" | "failed" | "unconnected" | "connecting"
  toolCount: number
  required: boolean
  authenticated: boolean
  loginState?: "pending" | "failed"
  error?: string
}>

export class McpServiceError extends Error {}

export function createMcpService(options: {
  oauth: McpOAuth
  managers: ReadonlyMap<string, McpConnectionManager>
  activateSession?(sessionId: string): Promise<void>
  readServers(
    sessionId?: string,
  ): Promise<Readonly<Record<string, McpServerConfig>>>
}) {
  const logins = new Map<
    string,
    { state: "pending" | "failed"; error?: string }
  >()
  const identity = (name: string, config: McpServerConfig) =>
    JSON.stringify([
      name,
      "url" in config ? [config.url, config.oauth] : config.command,
    ])
  const refresh = async (name: string) => {
    await Promise.all(
      [...options.managers].map(async ([sessionId, manager]) => {
        await manager.update(await options.readServers(sessionId))
        await manager.reconnect(name)
      }),
    )
  }
  const configured = async (name: string, sessionId?: string) => {
    const server = (await options.readServers(sessionId))[name]
    if (server === undefined)
      throw new McpServiceError(`MCP server ${name} is not configured.`)
    return server
  }
  return {
    async status(
      sessionId?: string,
    ): Promise<{ servers: readonly McpServerSummary[] }> {
      const servers = await options.readServers(sessionId)
      const status = options.managers.get(sessionId ?? "")?.status() ?? []
      return {
        servers: await Promise.all(
          Object.entries(servers).map(async ([name, config]) => {
            const current = status.find((entry) => entry.name === name)
            const login = logins.get(identity(name, config))
            const error = login?.error ?? current?.error
            return {
              name,
              transport:
                "url" in config ? ("http" as const) : ("stdio" as const),
              enabled: config.enabled !== false,
              state:
                config.enabled === false
                  ? ("stopped" as const)
                  : (current?.state ?? ("unconnected" as const)),
              toolCount: current?.toolCount ?? 0,
              required: config.required === true,
              authenticated:
                "url" in config &&
                (await options.oauth.hasCredentials(name, config)),
              ...(login === undefined ? {} : { loginState: login.state }),
              ...(error === undefined ? {} : { error }),
            }
          }),
        ),
      }
    },
    async login(
      name: string,
      sessionId?: string,
    ): Promise<{ authorizationUrl: string }> {
      const config = await configured(name, sessionId)
      if (!("url" in config))
        throw new McpServiceError("Only HTTP MCP servers use OAuth.")
      const key = identity(name, config)
      if (logins.get(key)?.state === "pending")
        throw new McpServiceError("A login is already in progress.")
      const state = { state: "pending" as const }
      logins.set(key, state)
      let login: Awaited<ReturnType<McpOAuth["startLogin"]>>
      try {
        login = await options.oauth.startLogin(name, config)
      } catch (error) {
        if (logins.get(key) === state) logins.delete(key)
        throw error
      }
      if (logins.get(key) !== state) {
        void login.completion.catch(() => {})
        await options.oauth.logout(name, config)
        throw new McpServiceError("The login was cancelled.")
      }
      void login.completion
        .then(async () => {
          if (logins.get(key) !== state) return
          if (sessionId !== undefined)
            await options.activateSession?.(sessionId)
          await refresh(name)
          if (logins.get(key) === state) logins.delete(key)
        })
        .catch((error: unknown) => {
          if (logins.get(key) === state)
            logins.set(key, {
              state: "failed",
              error: error instanceof Error ? error.message : String(error),
            })
        })
      return { authorizationUrl: login.authorizationUrl }
    },
    async logout(
      name: string,
      sessionId?: string,
    ): Promise<Record<string, never>> {
      const config = await configured(name, sessionId)
      logins.delete(identity(name, config))
      await options.oauth.logout(name, config)
      await refresh(name)
      return {}
    },
    async reconnect(
      name: string,
      sessionId?: string,
    ): Promise<Record<string, never>> {
      await configured(name, sessionId)
      if (sessionId === undefined) {
        await refresh(name)
        return {}
      }
      await options.activateSession?.(sessionId)
      const manager = options.managers.get(sessionId)
      if (manager === undefined)
        throw new McpServiceError("The session connection is unavailable.")
      await manager.update(await options.readServers(sessionId))
      await manager.reconnect(name)
      return {}
    },
  }
}

export type McpService = ReturnType<typeof createMcpService>
