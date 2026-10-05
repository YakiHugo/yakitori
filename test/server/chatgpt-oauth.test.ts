import { createHash } from "node:crypto"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { describe, expect, it } from "vitest"
import {
  createChatGPTOAuth,
  CHATGPT_TOKEN_URL,
} from "../../src/server/chatgpt-oauth.ts"

const hostId = "urn:uuid:2ba0b5bb-e079-484b-bafd-c87eab5f2fd6"
const redirectUri = "http://127.0.0.1:1455/auth/callback"
const issuer = "https://auth.openai.com"
const now = 1_800_000_000_000
const clientId = "oaiapp_fake"
const keys = await generateKeyPair("RS256")
const publicKey = {
  ...(await exportJWK(keys.publicKey)),
  kid: "fake-key",
  alg: "RS256",
  use: "sig",
}

async function fixture(
  input: {
    status?: number
    claims?: Record<string, unknown>
    token?: Record<string, unknown>
    beforeReply?: () => Promise<void>
    corruptSignature?: boolean
    selected?: {
      clientId: string
      subject: string
      idToken?: string
      email?: string
    }
  } = {},
) {
  const requests: { url: string; body: URLSearchParams }[] = []
  let clock = now
  let nonce = ""
  const auth = createChatGPTOAuth({
    hostId,
    now: () => clock,
    fetchFn: async (url, init) => {
      expect(init?.redirect).toBe("error")
      if (String(url) === `${issuer}/.well-known/jwks.json`)
        return Response.json({ keys: [publicKey] })
      expect(String(url)).toBe(CHATGPT_TOKEN_URL)
      const body = new URLSearchParams(String(init?.body))
      requests.push({ url: String(url), body })
      await input.beforeReply?.()
      const jwt = await new SignJWT({ nonce, ...input.claims })
        .setProtectedHeader({ alg: "RS256", kid: "fake-key" })
        .setIssuer(String(input.claims?.iss ?? issuer))
        .setAudience((input.claims?.aud as string) ?? clientId)
        .setSubject(String(input.claims?.sub ?? "subject-a"))
        .setIssuedAt(now / 1000)
        .setExpirationTime(Number(input.claims?.exp ?? now / 1000 + 300))
        .sign(
          input.corruptSignature
            ? (await generateKeyPair("RS256")).privateKey
            : keys.privateKey,
        )
      return Response.json(
        {
          token_type: "Bearer",
          id_token: jwt,
          access_token: "fake-access",
          refresh_token: "fake-refresh",
          expires_in: 3600,
          scope:
            "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          ...input.token,
        },
        { status: input.status ?? 200 },
      )
    },
  })
  const attempt = auth.begin(redirectUri, input.selected)
  const authorization = new URL(attempt.authorizationUrl)
  nonce = authorization.searchParams.get("nonce") ?? ""
  const callback = (updates: Record<string, string | null> = {}) => {
    const url = new URL(redirectUri)
    url.search = new URLSearchParams({
      state: authorization.searchParams.get("state") ?? "",
      code: "fake-code",
      client_id: clientId,
    }).toString()
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) url.searchParams.delete(key)
      else url.searchParams.set(key, value)
    }
    return url.href
  }
  return {
    auth,
    attempt,
    authorization,
    callback,
    requests,
    expire: () => {
      clock += 10 * 60 * 1000
    },
  }
}

describe("direct ChatGPT authorization", () => {
  it("binds issued registration, callback, PKCE, host, nonce, identity, and permission", async () => {
    const f = await fixture()
    expect(f.authorization.origin + f.authorization.pathname).toBe(
      `${issuer}/api/accounts/authorize`,
    )
    expect(f.authorization.searchParams.get("client_id")).toBe(
      "dynamic_agent_client",
    )
    expect(f.authorization.searchParams.get("agent_name_hint")).toBe("Yakitori")
    expect(f.authorization.searchParams.get("ext_agent_host_id")).toBe(hostId)
    expect(f.authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    )
    const credentials = await f.attempt.complete(f.callback())
    expect(credentials).toMatchObject({
      issuer,
      clientId,
      subject: "subject-a",
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: now + 3600000,
    })
    const body = f.requests[0]?.body
    expect(body?.get("client_id")).toBe(clientId)
    expect(body?.get("redirect_uri")).toBe(redirectUri)
    expect(body?.get("resource")).toBe("https://api.openai.com/v1")
    expect(body?.get("grant_type")).toBe("authorization_code")
    expect(body?.has("client_secret")).toBe(false)
    const verifier = body?.get("code_verifier") ?? ""
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      f.authorization.searchParams.get("code_challenge"),
    )
    await expect(f.attempt.complete(f.callback())).rejects.toMatchObject({
      code: "expired_attempt",
    })
    expect(f.requests).toHaveLength(1)
  })

  it("generates distinct transaction secrets and reuses a selected registration without a name hint", async () => {
    const selected = {
      clientId,
      subject: "subject-a",
      idToken: "fake-id-hint",
      email: "test@example.invalid",
    }
    const f = await fixture({ selected })
    const next = new URL(f.auth.begin(redirectUri, selected).authorizationUrl)
    for (const key of ["state", "nonce", "code_challenge"])
      expect(next.searchParams.get(key)).not.toBe(
        f.authorization.searchParams.get(key),
      )
    expect(f.authorization.searchParams.get("client_id")).toBe(clientId)
    expect(f.authorization.searchParams.has("agent_name_hint")).toBe(false)
    expect(f.authorization.searchParams.get("id_token_hint")).toBe(
      selected.idToken,
    )
    await expect(
      f.attempt.complete(f.callback({ client_id: null })),
    ).resolves.toMatchObject({ clientId })
  })

  it.each([
    "http://localhost:1455/auth/callback",
    "https://127.0.0.1:1455/auth/callback",
    "http://127.0.0.1:1455/callback",
    "http://127.0.0.1:1455/auth/callback?x=y",
    "http://user@127.0.0.1:1455/auth/callback",
  ])("rejects unsafe or mismatched listener URL %s", async (uri) => {
    const f = await fixture()
    expect(() => f.auth.begin(uri)).toThrow("loopback")
  })

  it("does not consume a pending attempt for an unrelated callback", async () => {
    const f = await fixture()
    await expect(
      f.attempt.complete(f.callback({ state: "attacker" })),
    ).rejects.toMatchObject({ code: "invalid_callback" })
    await expect(
      f.attempt.complete(f.callback().replace(":1455/", ":1456/")),
    ).rejects.toMatchObject({ code: "invalid_callback" })
    expect(f.requests).toHaveLength(0)
    await expect(f.attempt.complete(f.callback())).resolves.toMatchObject({
      clientId,
    })
  })

  it.each([
    { client_id: null },
    { client_id: "dynamic_agent_client" },
    { code: null },
    { error: "access_denied" },
  ])("rejects incomplete or denied registrations without exchange: %j", async (updates) => {
    const f = await fixture()
    await expect(f.attempt.complete(f.callback(updates))).rejects.toThrow(
      "ChatGPT sign-in failed",
    )
    expect(f.requests).toHaveLength(0)
  })

  it("rejects duplicate callback fields and consumes the matched attempt", async () => {
    const f = await fixture()
    await expect(
      f.attempt.complete(`${f.callback()}&code=other`),
    ).rejects.toMatchObject({ code: "invalid_callback" })
    await expect(f.attempt.complete(f.callback())).rejects.toMatchObject({
      code: "expired_attempt",
    })
    expect(f.requests).toHaveLength(0)
  })

  it("rejects account/client replacement before any credential update", async () => {
    const selected = { clientId, subject: "different-subject" }
    const f = await fixture({ selected })
    await expect(f.attempt.complete(f.callback())).rejects.toMatchObject({
      code: "invalid_token",
    })
    const g = await fixture({ selected })
    await expect(
      g.attempt.complete(g.callback({ client_id: "oaiapp_other" })),
    ).rejects.toMatchObject({ code: "invalid_callback" })
    expect(g.requests).toHaveLength(0)
  })

  it.each([
    { claims: { iss: "https://attacker.invalid" } },
    { claims: { aud: "oaiapp_other" } },
    { claims: { exp: now / 1000 - 10 } },
    { claims: { nonce: "wrong-nonce" } },
    { claims: { sub: "" } },
    { claims: { azp: "oaiapp_other" } },
    { corruptSignature: true },
    { token: { id_token: "fake-secret-malformed-jwt" } },
  ])("rejects unverified identity without leaking token contents: %j", async (input) => {
    const f = await fixture(input)
    await expect(f.attempt.complete(f.callback())).rejects.toMatchObject({
      code: "invalid_token",
      message: "ChatGPT sign-in failed (invalid_token).",
    })
  })

  it("requires granted plan permission rather than callback scopes or valid identity alone", async () => {
    const f = await fixture({ token: { scope: "openid profile email" } })
    await expect(
      f.attempt.complete(f.callback({ scope: "chatgpt.tokens.use.direct" })),
    ).rejects.toMatchObject({ code: "missing_permission" })
  })

  it("retains validated identity without plan tokens when consent is missing", async () => {
    const f = await fixture({
      token: {
        scope: "openid profile email",
        access_token: undefined,
        refresh_token: undefined,
      },
    })
    await expect(f.attempt.complete(f.callback())).rejects.toMatchObject({
      code: "missing_permission",
    })
    expect(f.attempt.registration).toEqual({ clientId, subject: "subject-a" })
    expect(JSON.stringify(f.attempt.registration)).not.toContain("token")
  })

  it("retains an issued client after failed exchange for a fresh PKCE attempt", async () => {
    const f = await fixture({ status: 400, token: { error: "invalid_grant" } })
    await expect(f.attempt.complete(f.callback())).rejects.toMatchObject({
      code: "exchange_failed",
    })
    expect(f.attempt.registration).toBeUndefined()
    expect(f.attempt.issuedClientId).toBe(clientId)
    const retry = f.auth.begin(redirectUri, undefined, f.attempt.issuedClientId)
    const url = new URL(retry.authorizationUrl)
    expect(url.searchParams.get("client_id")).toBe(clientId)
    expect(url.searchParams.has("agent_name_hint")).toBe(false)
    expect(url.searchParams.get("state")).not.toBe(
      f.authorization.searchParams.get("state"),
    )
  })

  it("consumes one concurrent callback and suppresses an in-flight cancelled result", async () => {
    let enter = () => {}
    let release = () => {}
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = await fixture({
      beforeReply: async () => {
        enter()
        await released
      },
    })
    const pending = f.attempt.complete(f.callback())
    await entered
    await expect(f.attempt.complete(f.callback())).rejects.toMatchObject({
      code: "expired_attempt",
    })
    f.attempt.cancel()
    release()
    await expect(pending).rejects.toMatchObject({ code: "expired_attempt" })
    expect(f.requests).toHaveLength(1)
  })

  it("normalizes operational exchange failures and cancellation without leaking errors", async () => {
    for (const cause of [
      new TypeError("fake-secret-in-error"),
      new DOMException("fake-secret", "TimeoutError"),
    ]) {
      const auth = createChatGPTOAuth({
        hostId,
        fetchFn: async () => {
          throw cause
        },
      })
      const attempt = auth.begin(redirectUri)
      const state = new URL(attempt.authorizationUrl).searchParams.get("state")
      await expect(
        attempt.complete(
          `${redirectUri}?state=${state}&client_id=${clientId}&code=fake`,
        ),
      ).rejects.toMatchObject({
        code: "exchange_failed",
        message: "ChatGPT sign-in failed (exchange_failed).",
      })
    }
  })

  it("expires and cancels abandoned attempts without making requests", async () => {
    const f = await fixture()
    f.expire()
    await expect(f.attempt.complete(f.callback())).rejects.toMatchObject({
      code: "expired_attempt",
    })
    const g = await fixture()
    g.attempt.cancel()
    await expect(g.attempt.complete(g.callback())).rejects.toMatchObject({
      code: "expired_attempt",
    })
    expect([...f.requests, ...g.requests]).toHaveLength(0)
  })
})
