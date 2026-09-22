import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createMcpConnectionManager } from "../../src/runtime/mcp-connection-manager.ts"
import { createMcpOAuth } from "../../src/runtime/mcp-oauth.ts"

it("logs in with SDK discovery and PKCE, persists credentials, refreshes once, and logs out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-mcp-oauth-"))
  let base = ""
  let challenge = ""
  let refreshes = 0
  let registrations = 0
  let tokenRequests = 0
  let toolCalls = 0
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json")
    const path = new URL(request.url ?? "/", base).pathname
    if (path === "/mcp") {
      if (request.headers.authorization !== "Bearer access-refreshed") {
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
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number
        method: string
        params?: { protocolVersion?: string }
      }
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      if (message.method === "tools/call" && ++toolCalls === 1) {
        response.writeHead(401).end("{}")
        return
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : message.method === "tools/list"
            ? { tools: [{ name: "write", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "completed" }] }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
      return
    }
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
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    if (path === "/register") {
      registrations++
      response.writeHead(201).end(
        JSON.stringify({
          ...JSON.parse(body),
          client_id: "fixture-client",
        }),
      )
      return
    }
    if (path === "/token") {
      tokenRequests++
      const params = new URLSearchParams(body)
      if (params.get("grant_type") === "refresh_token") {
        refreshes++
        expect(params.get("refresh_token")).toBe("refresh-original")
        response.end(
          JSON.stringify({
            access_token: "access-refreshed",
            refresh_token: "refresh-rotated",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        )
      } else {
        expect(params.get("code")).toBe("authorization-code")
        expect(
          createHash("sha256")
            .update(params.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(challenge)
        expect(params.get("resource")).toBe(`${base}/mcp`)
        response.end(
          JSON.stringify({
            access_token: "access-original",
            refresh_token: "refresh-original",
            token_type: "Bearer",
            expires_in: 0,
          }),
        )
      }
      return
    }
    response.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing listener")
  base = `http://127.0.0.1:${address.port}`
  const config = { url: `${base}/mcp` }
  const oauth = createMcpOAuth({ storePath: directory })
  let restored: ReturnType<typeof createMcpOAuth> | undefined
  try {
    expect(await oauth.hasCredentials("remote", config)).toBe(false)
    const manager = createMcpConnectionManager({
      authProvider: oauth.provider,
      maxRestartAttempts: 0,
    })
    try {
      await manager.update({ remote: config })
      expect(manager.status()).toMatchObject([
        { state: "failed", errorCode: "authentication_required" },
      ])
      expect(registrations).toBe(0)
    } finally {
      await manager.close()
    }
    const login = await oauth.startLogin("remote", config)
    const authorization = new URL(login.authorizationUrl)
    expect(authorization.origin).toBe(base)
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
    challenge = authorization.searchParams.get("code_challenge") ?? ""
    expect(challenge).not.toBe("")
    const callback = new URL(
      authorization.searchParams.get("redirect_uri") ?? "",
    )
    expect(callback.hostname).toBe("127.0.0.1")
    callback.searchParams.set("code", "authorization-code")
    callback.searchParams.set("state", "invalid")
    expect((await fetch(callback)).status).toBe(400)
    expect(tokenRequests).toBe(0)
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state") ?? "",
    )
    expect((await fetch(callback)).status).toBe(200)
    await login.completion
    expect(await oauth.hasCredentials("remote", config)).toBe(true)
    expect(registrations).toBe(1)
    await oauth.close()

    restored = createMcpOAuth({ storePath: directory })
    const provider = restored.provider("remote", config)
    const tokens = await Promise.all([provider?.tokens(), provider?.tokens()])
    expect(tokens).toEqual([
      {
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        token_type: "Bearer",
        expires_in: 3600,
      },
      {
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        token_type: "Bearer",
        expires_in: 3600,
      },
    ])
    expect(refreshes).toBe(1)
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    const filename = files[0]
    if (!filename) throw new Error("Missing persisted credentials")
    const path = join(directory, filename)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, "utf8")).tokens.refresh_token).toBe(
      "refresh-rotated",
    )
    const authenticated = createMcpConnectionManager({
      authProvider: restored.provider,
      restartDelayMs: 1,
    })
    try {
      await authenticated.update({ remote: config })
      const original = authenticated.tools()[0]
      await expect(
        original?.execute({}, { workspaceRoot: directory }),
      ).rejects.toThrow()
      await expect
        .poll(
          () =>
            authenticated.tools()[0] !== undefined &&
            authenticated.tools()[0] !== original,
        )
        .toBe(true)
      expect(toolCalls).toBe(1)
      expect(refreshes).toBe(1)
      await expect(
        authenticated.tools()[0]?.execute({}, { workspaceRoot: directory }),
      ).resolves.toMatchObject({ content: "completed" })
      expect(toolCalls).toBe(2)
    } finally {
      await authenticated.close()
    }
    expect(await restored.hasCredentials("other-server", config)).toBe(false)
    await restored.logout("remote", config)
    expect(await restored.hasCredentials("remote", config)).toBe(false)
    expect(await readdir(directory)).toEqual([])
    const pending = await restored.startLogin("remote", config)
    await restored.close()
    await expect(pending.completion).rejects.toThrow("MCP OAuth closed.")
  } finally {
    await oauth.close()
    await restored?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(directory, { recursive: true, force: true })
  }
})

it("does not expose OAuth when explicit authorization is configured", async () => {
  const oauth = createMcpOAuth({
    storePath: join(tmpdir(), "unused-mcp-oauth"),
  })
  expect(oauth.provider("stdio", { command: "echo" })).toBeUndefined()
  expect(
    oauth.provider("bearer", {
      url: "https://example.com",
      bearerTokenEnvVar: "TOKEN",
    }),
  ).toBeUndefined()
  expect(
    oauth.provider("headers", {
      url: "https://example.com",
      httpHeaders: { authorization: "Bearer token" },
    }),
  ).toBeUndefined()
  await oauth.close()
})
