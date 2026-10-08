import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { afterEach, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  auth: sdk.auth,
}))
import { createMcpOAuth } from "../../src/runtime/mcp-oauth.ts"

const config = {
  url: "https://fixture.invalid/mcp",
  oauth: { clientId: "fixture" },
}
const rotated = {
  access_token: "test-rotated",
  token_type: "Bearer",
  expires_in: 3600,
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  sdk.auth.mockReset()
})
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-lifecycle-"))
  const key = createHash("sha256")
    .update(JSON.stringify(["remote", config.url, config.oauth]))
    .digest("hex")
  const path = join(root, `${key}.json`)
  await writeFile(
    path,
    JSON.stringify({
      tokens: {
        access_token: "test-expired",
        refresh_token: "test-refresh",
        token_type: "Bearer",
      },
      expiresAt: 1,
    }),
  )
  const oauth = createMcpOAuth({ storePath: root })
  cleanup.push(async () => {
    await oauth.close()
    await rm(root, { recursive: true, force: true })
  })
  const provider = oauth.provider("remote", config)
  if (!provider) throw new Error("Missing OAuth provider")
  await oauth.hasCredentials("remote", config)
  return { root, path, oauth, provider }
}

it("does not start an expired-token refresh during logout", async () => {
  const { root, oauth, provider } = await fixture()
  const finish = gate()
  cleanup.push(async () => finish.release())
  sdk.auth.mockImplementation(async (raw: OAuthClientProvider) => {
    await finish.promise
    await raw.saveTokens(rotated)
    return "AUTHORIZED"
  })
  const logout = oauth.logout("remote", config)
  const tokens = provider.tokens()
  await logout
  expect(await oauth.hasCredentials("remote", config)).toBe(false)
  finish.release()
  await tokens
  expect(await oauth.hasCredentials("remote", config)).toBe(false)
  await expect(tokens).resolves.toBeUndefined()
  expect(sdk.auth).not.toHaveBeenCalled()
  expect(await oauth.hasCredentials("remote", config)).toBe(false)
  expect(await readdir(root)).toEqual([])
})

it("drains an earlier refresh before deleting its durable credentials", async () => {
  const { root, oauth, provider } = await fixture()
  const started = gate()
  const finish = gate()
  cleanup.push(async () => finish.release())
  sdk.auth.mockImplementation(async (raw: OAuthClientProvider) => {
    started.release()
    await finish.promise
    await raw.saveTokens(rotated)
    return "AUTHORIZED"
  })
  const tokens = provider.tokens()
  await started.promise
  const logout = oauth.logout("remote", config)
  finish.release()
  await Promise.all([tokens, logout])
  expect(await oauth.hasCredentials("remote", config)).toBe(false)
  expect(await readdir(root)).toEqual([])
})

it("retains a successful refresh and shares it across concurrent token reads", async () => {
  const { path, provider } = await fixture()
  sdk.auth.mockImplementation(async (raw: OAuthClientProvider) => {
    await raw.saveTokens(rotated)
    return "AUTHORIZED"
  })
  expect(await Promise.all([provider.tokens(), provider.tokens()])).toEqual([
    rotated,
    rotated,
  ])
  expect(sdk.auth).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await readFile(path, "utf8")).tokens).toEqual(rotated)
})

it("cancels a pending login and waits for its final credential write before deleting", async () => {
  const { root, oauth } = await fixture()
  const started = gate()
  const finish = gate()
  cleanup.push(async () => finish.release())
  sdk.auth.mockImplementation(async (raw: OAuthClientProvider) => {
    started.release()
    await finish.promise
    await raw.saveTokens(rotated)
    return "AUTHORIZED"
  })
  const login = oauth.startLogin("remote", config)
  const rejected = expect(login).rejects.toThrow("MCP OAuth login failed.")
  await started.promise
  const logout = oauth.logout("remote", config)
  finish.release()
  await Promise.all([logout, rejected])
  expect(await oauth.hasCredentials("remote", config)).toBe(false)
  expect(await readdir(root)).toEqual([])
})

it("cancels a login waiting for an earlier refresh when logout begins", async () => {
  const { root, oauth, provider } = await fixture()
  const started = gate()
  const finish = gate()
  cleanup.push(async () => finish.release())
  sdk.auth.mockImplementation(async (raw: OAuthClientProvider) => {
    started.release()
    await finish.promise
    await raw.saveTokens(rotated)
    return "AUTHORIZED"
  })
  const tokens = provider.tokens()
  await started.promise
  const login = oauth.startLogin("remote", config)
  const rejected = expect(login).rejects.toThrow("MCP login cancelled.")
  const logout = oauth.logout("remote", config)
  finish.release()
  await Promise.all([tokens, logout, rejected])
  expect(sdk.auth).toHaveBeenCalledTimes(1)
  expect(await readdir(root)).toEqual([])
})

it("lets a new explicit login register after concurrent logout finishes", async () => {
  const { path, oauth } = await fixture()
  sdk.auth.mockImplementation(async (raw: OAuthClientProvider) => {
    await raw.saveClientInformation?.({ client_id: "new-registration" })
    await raw.redirectToAuthorization(
      new URL("https://fixture.invalid/authorize"),
    )
    return "REDIRECT"
  })
  const logout = oauth.logout("remote", config)
  const login = oauth.startLogin("remote", config)
  await logout
  const pending = await login
  expect(pending.authorizationUrl).toBe("https://fixture.invalid/authorize")
  expect(JSON.parse(await readFile(path, "utf8")).client).toEqual({
    client_id: "new-registration",
  })
  await oauth.close()
  await expect(pending.completion).rejects.toThrow("MCP OAuth closed.")
})

it("lets a second logout cancel a login queued behind the first logout", async () => {
  const { root, oauth } = await fixture()
  const first = oauth.logout("remote", config)
  const login = oauth.startLogin("remote", config)
  const rejected = expect(login).rejects.toThrow("MCP login cancelled.")
  const second = oauth.logout("remote", config)
  await Promise.all([first, second, rejected])
  expect(sdk.auth).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})
