import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resolveGrokAccessToken,
  resolveGrokAccountIdentity,
  resolveGrokCredentials,
} from "../../src/runtime/grok-credentials.ts"

describe("Grok OIDC credentials (read-only)", () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    vi.stubEnv("XAI_API_KEY", undefined)
    dir = await mkdtemp(join(tmpdir(), "yakitori-grok-"))
    path = join(dir, "auth.json")
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  const publicScope = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"
  const enterpriseScope = "https://login.example.com::enterprise-client"
  const enterpriseLogin = {
    key: "enterprise-access",
    user_id: "enterprise-user",
    expires_at: new Date(1_000_000_000).toISOString(),
  }

  const writeAuth = (expiresAt: string, userId: string | null = "user-1") =>
    writeFile(
      path,
      JSON.stringify({
        [publicScope]: {
          key: "stored-access",
          auth_mode: "oidc",
          refresh_token: "stored-refresh",
          expires_at: expiresAt,
          oidc_issuer: "https://auth.x.ai",
          oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
          ...(userId === null ? {} : { user_id: userId }),
        },
      }),
    )

  it("returns the stored token when it is fresh", async () => {
    await writeAuth(new Date(1_000_000_000).toISOString())
    const token = await resolveGrokAccessToken({ path, now: () => 500_000 })
    expect(token).toBe("stored-access")
  })

  it("returns the user identity needed for subscription billing", async () => {
    await writeAuth(new Date(1_000_000_000).toISOString())
    await expect(
      resolveGrokCredentials({ path, now: () => 500_000 }),
    ).resolves.toEqual({
      accessToken: "stored-access",
      userId: "user-1",
      expiresAt: 1_000_000,
    })
  })

  it("keeps model access usable when an older login lacks a billing identity", async () => {
    await writeAuth(new Date(1_000_000_000).toISOString(), null)
    await expect(
      resolveGrokAccessToken({ path, now: () => 500_000 }),
    ).resolves.toBe("stored-access")
    await expect(
      resolveGrokCredentials({ path, now: () => 500_000 }),
    ).rejects.toThrow(/user identity/)
  })

  it("rejects a near-expiry token with a re-login hint", async () => {
    await writeAuth(new Date(1_000_000).toISOString())
    await expect(
      resolveGrokAccessToken({ path, now: () => 999 }),
    ).rejects.toThrow(/log in again/)
  })

  it("uses the public xAI scope for access, billing identity and account cache identity", async () => {
    await writeFile(
      path,
      JSON.stringify({
        [enterpriseScope]: enterpriseLogin,
        [publicScope]: {
          key: "public-access",
          user_id: "public-user",
          expires_at: new Date(1_000_000_000).toISOString(),
        },
      }),
    )
    await expect(
      resolveGrokAccessToken({ path, now: () => 500_000 }),
    ).resolves.toBe("public-access")
    await expect(
      resolveGrokCredentials({ path, now: () => 500_000 }),
    ).resolves.toEqual({
      accessToken: "public-access",
      userId: "public-user",
      expiresAt: 1_000_000,
    })
    await expect(resolveGrokAccountIdentity({ path })).resolves.toBe(
      "public-user",
    )
  })

  it("requires the public scope when only unrelated logins exist", async () => {
    await writeFile(
      path,
      JSON.stringify({
        [enterpriseScope]: enterpriseLogin,
        "https://auth.x.ai::other-client": enterpriseLogin,
        "https://accounts.x.ai/sign-in": enterpriseLogin,
      }),
    )
    await expect(
      resolveGrokAccessToken({ path, now: () => 500_000 }),
    ).rejects.toThrow(/no login/)
    await expect(resolveGrokAccountIdentity({ path })).rejects.toThrow(
      /no login/,
    )
  })

  it.each([
    null,
    [],
    {},
    { key: "", expires_at: new Date(1_000_000_000).toISOString() },
    { key: "public-access", expires_at: 1_000_000 },
    { key: "public-access", expires_at: "not-a-date" },
  ])("does not substitute an enterprise login for malformed public credentials (%j)", async (publicLogin) => {
    await writeFile(
      path,
      JSON.stringify({
        [enterpriseScope]: enterpriseLogin,
        [publicScope]: publicLogin,
      }),
    )
    await expect(
      resolveGrokAccessToken({ path, now: () => 500_000 }),
    ).rejects.toThrow(/malformed xAI login|bad expires_at/)
  })

  it("does not substitute a fresh enterprise login for expired public credentials", async () => {
    await writeFile(
      path,
      JSON.stringify({
        [enterpriseScope]: enterpriseLogin,
        [publicScope]: {
          key: "expired-public-access",
          user_id: "public-user",
          expires_at: new Date(1_000_000).toISOString(),
        },
      }),
    )
    await expect(
      resolveGrokAccessToken({ path, now: () => 1_001 }),
    ).rejects.toThrow(/expired/)
  })

  it("uses the environment API key identity without reading a CLI login", async () => {
    vi.stubEnv("XAI_API_KEY", "environment-key")
    await writeFile(path, "invalid JSON")
    await expect(resolveGrokAccountIdentity({ path })).resolves.toBe(
      "a0ef3e034d912dcbe888a0a45df972d7458960e910c0947d6141b6d36dd885e6",
    )
  })

  it("preserves a credential file read failure that is not a missing file", async () => {
    await expect(resolveGrokAccessToken({ path: dir })).rejects.toMatchObject({
      code: "EISDIR",
    })
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
