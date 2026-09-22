import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import {
  createMcpConnectionManager,
  type McpServerConfig,
} from "../../src/runtime/mcp-connection-manager.ts"
import { createMcpOAuth } from "../../src/runtime/mcp-oauth.ts"
import { createMcpService } from "../../src/server/mcp-service.ts"
import type {
  McpRpcParams,
  McpRpcResponses,
} from "../../src/server/rpc/mcp-methods.ts"
import { INVALID_PARAMS } from "../../src/server/rpc/messages.ts"
import {
  type RpcMethodContext,
  rpcMethods,
} from "../../src/server/rpc/methods.ts"

async function withMcpService(
  run: (fixture: {
    invoke<K extends keyof McpRpcParams>(
      method: K,
      params: McpRpcParams[K],
    ): Promise<McpRpcResponses[K]>
    configs: Map<string, Record<string, McpServerConfig>>
    managers: Map<string, ReturnType<typeof createMcpConnectionManager>>
    oauth: ReturnType<typeof createMcpOAuth>
    config: McpServerConfig
    counters: { calls: number; tokens: number }
    failAuthorization(): void
    root: string
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-service-"))
  let base = ""
  let rejectAuthorization = false
  const counters = { calls: 0, tokens: 0 }
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json")
    const path = new URL(request.url ?? "/", base).pathname
    if (path.includes("/.well-known/oauth-protected-resource")) {
      response.end(
        JSON.stringify({
          resource: `${base}/mcp`,
          authorization_servers: [base],
        }),
      )
      return
    }
    if (path.includes("/.well-known/")) {
      response.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      )
      return
    }
    if (
      path === "/mcp" &&
      request.headers.authorization !== "Bearer private-access-token"
    ) {
      response
        .writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end("{}")
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    if (path === "/register") {
      response.writeHead(201).end(
        JSON.stringify({
          ...JSON.parse(body),
          client_id: "service-fixture",
        }),
      )
      return
    }
    if (path === "/token") {
      counters.tokens++
      if (rejectAuthorization) {
        response.writeHead(400).end(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "private-server-error-token",
          }),
        )
        return
      }
      response.end(
        JSON.stringify({
          access_token: "private-access-token",
          refresh_token: "private-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      )
      return
    }
    const message = JSON.parse(body) as {
      id?: number
      method: string
      params?: { protocolVersion?: string }
    }
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    if (message.method === "tools/call") counters.calls++
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "service-fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: ["first", "second"].map((name) => ({
                name,
                inputSchema: { type: "object" },
              })),
            }
          : { content: [{ type: "text", text: "called once" }] }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing listener")
  base = `http://127.0.0.1:${address.port}`
  const config: McpServerConfig = {
    url: `${base}/mcp`,
    enabledTools: ["first"],
  }
  const configs = new Map([
    ["session_one", { remote: config }],
    ["session_two", { remote: config }],
  ])
  const oauth = createMcpOAuth({ storePath: join(root, "oauth") })
  const managers = new Map(
    [...configs.keys()].map((sessionId) => [
      sessionId,
      createMcpConnectionManager({
        authProvider: oauth.provider,
        maxRestartAttempts: 0,
      }),
    ]),
  )
  const service = createMcpService({
    oauth,
    managers,
    async readServers(sessionId = "session_one") {
      return configs.get(sessionId) ?? {}
    },
  })
  // Exercise the actual RPC method boundary and service. Other context members
  // belong to unrelated RPCs and are deliberately absent from this fixture.
  const context = { mcp: service } as RpcMethodContext
  try {
    await Promise.all(
      [...managers].map(([sessionId, manager]) =>
        manager.update(configs.get(sessionId) ?? {}),
      ),
    )
    await run({
      async invoke(method, params) {
        const definition = rpcMethods.find(
          (definition) => definition.method === method,
        )
        if (!definition) throw new Error(`Missing RPC method ${method}`)
        return (await definition.invoke(params, context))
          .result as McpRpcResponses[typeof method]
      },
      configs,
      managers,
      oauth,
      config,
      counters,
      root,
      failAuthorization() {
        rejectAuthorization = true
      },
    })
  } finally {
    await Promise.all([...managers.values()].map((manager) => manager.close()))
    await oauth.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  }
}

function callback(authorizationUrl: string): URL {
  const authorization = new URL(authorizationUrl)
  const url = new URL(authorization.searchParams.get("redirect_uri") ?? "")
  url.searchParams.set("code", "service-code")
  url.searchParams.set("state", authorization.searchParams.get("state") ?? "")
  return url
}

it("activates catalogs through login RPC and removes them on logout without invoking tools", async () => {
  await withMcpService(async ({ invoke, managers, counters, root }) => {
    expect(
      (await invoke("mcp/status", { sessionId: "session_one" })).servers,
    ).toMatchObject([
      { name: "remote", state: "failed", authenticated: false, toolCount: 0 },
    ])
    const login = await invoke("mcp/login", {
      name: "remote",
      sessionId: "session_one",
    })
    expect(
      (await invoke("mcp/status", { sessionId: "session_one" })).servers[0]
        ?.loginState,
    ).toBe("pending")
    expect((await fetch(callback(login.authorizationUrl))).status).toBe(200)
    for (const sessionId of managers.keys()) {
      await expect
        .poll(
          async () => (await invoke("mcp/status", { sessionId })).servers[0],
        )
        .toMatchObject({
          state: "ready",
          authenticated: true,
          toolCount: 1,
        })
      expect(
        managers
          .get(sessionId)
          ?.tools()
          .map((tool) => tool.toolName.name),
      ).toEqual(["first"])
    }
    expect(counters.calls).toBe(0)
    const first = managers.get("session_one")?.tools()[0]
    const secondSession = managers.get("session_two")?.tools()[0]
    await expect(
      first?.execute({}, { workspaceRoot: root }),
    ).resolves.toMatchObject({ content: "called once" })
    await invoke("mcp/reconnect", { name: "remote", sessionId: "session_one" })
    expect(managers.get("session_one")?.tools()[0]).not.toBe(first)
    expect(managers.get("session_two")?.tools()[0]).toBe(secondSession)
    expect(counters.calls).toBe(1)
    await invoke("mcp/logout", { name: "remote", sessionId: "session_one" })
    for (const sessionId of managers.keys()) {
      const status = await invoke("mcp/status", { sessionId })
      expect(status.servers).toMatchObject([
        { authenticated: false, state: "failed", toolCount: 0 },
      ])
      expect(managers.get(sessionId)?.tools()).toEqual([])
      expect(JSON.stringify(status)).not.toMatch(
        /private-(access|refresh)-token/,
      )
    }
    expect(counters.calls).toBe(1)

    const pending = await invoke("mcp/login", {
      name: "remote",
      sessionId: "session_one",
    })
    await invoke("mcp/logout", { name: "remote", sessionId: "session_one" })
    await expect(fetch(callback(pending.authorizationUrl))).rejects.toThrow()
    const status = await invoke("mcp/status", { sessionId: "session_one" })
    expect(status.servers[0]?.loginState).toBeUndefined()
    expect(status.servers[0]?.authenticated).toBe(false)
    expect(counters.tokens).toBe(1)
  })
})

it("uses current per-session configuration and OAuth identity when login completes", async () => {
  await withMcpService(async ({ invoke, configs, managers, config, oauth }) => {
    const login = await invoke("mcp/login", {
      name: "remote",
      sessionId: "session_one",
    })
    const current = {
      ...config,
      enabledTools: ["second"],
      oauth: { scopes: ["new-scope"] },
    }
    configs.set("session_one", { remote: current })
    configs.delete("session_two")
    expect((await fetch(callback(login.authorizationUrl))).status).toBe(200)
    await expect
      .poll(async () => await oauth.hasCredentials("remote", config))
      .toBe(true)
    await expect.poll(() => managers.get("session_two")?.status()).toEqual([])
    expect(
      (await invoke("mcp/status", { sessionId: "session_one" })).servers,
    ).toMatchObject([{ state: "failed", authenticated: false, toolCount: 0 }])
    expect(managers.get("session_one")?.tools()).toEqual([])

    const currentLogin = await invoke("mcp/login", {
      name: "remote",
      sessionId: "session_one",
    })
    expect((await fetch(callback(currentLogin.authorizationUrl))).status).toBe(
      200,
    )
    await expect
      .poll(() =>
        managers
          .get("session_one")
          ?.tools()
          .map((tool) => tool.toolName.name),
      )
      .toEqual(["second"])
    expect(
      (await invoke("mcp/status", { sessionId: "session_one" })).servers,
    ).toMatchObject([{ state: "ready", authenticated: true, toolCount: 1 }])
    configs.set("session_one", { remote: { ...current, enabled: false } })
    await invoke("mcp/reconnect", { name: "remote", sessionId: "session_one" })
    expect(managers.get("session_one")?.tools()).toEqual([])
    expect(
      (await invoke("mcp/status", { sessionId: "session_one" })).servers,
    ).toMatchObject([{ state: "stopped", enabled: false, toolCount: 0 }])
  })
})

it("returns sanitized authorization failures and maps unknown servers to invalid RPC parameters", async () => {
  await withMcpService(async ({ invoke, failAuthorization }) => {
    await expect(
      invoke("mcp/login", { name: "missing" }),
    ).rejects.toMatchObject({ rpcCode: INVALID_PARAMS })
    failAuthorization()
    const login = await invoke("mcp/login", { name: "remote" })
    expect((await fetch(callback(login.authorizationUrl))).status).toBe(400)
    await expect
      .poll(async () => (await invoke("mcp/status", {})).servers[0]?.loginState)
      .toBe("failed")
    const status = await invoke("mcp/status", {})
    expect(status.servers[0]?.error).toBe("MCP OAuth authorization failed.")
    expect(JSON.stringify(status)).not.toContain("private-server-error-token")
  })
})
