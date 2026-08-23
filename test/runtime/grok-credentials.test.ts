import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveGrokAccessToken } from "../../src/runtime/grok-credentials.ts"

describe("Grok OIDC credentials (read-only)", () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yakitori-grok-"))
    path = join(dir, "auth.json")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const writeAuth = (expiresAt: string) =>
    writeFile(
      path,
      JSON.stringify({
        "https://auth.x.ai::client-1": {
          key: "stored-access",
          auth_mode: "oidc",
          refresh_token: "stored-refresh",
          expires_at: expiresAt,
          oidc_issuer: "https://auth.x.ai",
          oidc_client_id: "client-1",
        },
      }),
    )

  it("returns the stored token when it is fresh", async () => {
    await writeAuth(new Date(1_000_000_000).toISOString())
    const token = await resolveGrokAccessToken({ path, now: () => 500_000 })
    expect(token).toBe("stored-access")
  })

  it("rejects a near-expiry token with a re-login hint", async () => {
    await writeAuth(new Date(1_000_000).toISOString())
    await expect(
      resolveGrokAccessToken({ path, now: () => 999_000 }),
    ).rejects.toThrow(/log in again/)
  })

  it("surfaces a login hint when credentials are missing", async () => {
    await expect(resolveGrokAccessToken({ path })).rejects.toThrow(/grok/)
  })

  it("rejects a file without a login entry", async () => {
    await writeFile(path, JSON.stringify({ other: { key: 1 } }))
    await expect(resolveGrokAccessToken({ path })).rejects.toThrow(/no login/)
  })

  it("rejects a malformed expires_at", async () => {
    await writeAuth("not-a-date")
    await expect(resolveGrokAccessToken({ path })).rejects.toThrow(/expires_at/)
  })
})
