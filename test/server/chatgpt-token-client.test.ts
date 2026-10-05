import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { describe, expect, it } from "vitest"
import { createChatGPTTokenClient } from "../../src/server/chatgpt-token-client.ts"
import {
  ChatGPTRefreshRevokedError,
  ChatGPTPendingRenewalExpiredError,
  createChatGPTCredentialStore,
} from "../../src/server/chatgpt-credential-store.ts"
import {
  CHATGPT_TOKEN_URL,
  type ChatGPTCredentials,
} from "../../src/server/chatgpt-oauth.ts"

const now = 1800000000000
const previous: ChatGPTCredentials = {
  issuer: "https://auth.openai.com",
  clientId: "oaiapp_fake",
  subject: "subject-a",
  idToken: "fake-old-id",
  accessToken: "fake-old-access",
  refreshToken: "fake-old-refresh",
  scopes: ["openid", "resource.invoke", "chatgpt.tokens.use.direct"],
  expiresAt: now,
}
const renewed = {
  token_type: "Bearer",
  access_token: "fake-new-access",
  refresh_token: "fake-new-refresh",
  expires_in: 3600,
}
const signal = () => new AbortController().signal

describe("ChatGPT token protocol", () => {
  it("refreshes only against the issued client and resource, preserving omitted scopes and ID hint", async () => {
    const client = createChatGPTTokenClient({
      now: () => now,
      fetchFn: async (url, init) => {
        expect(String(url)).toBe(CHATGPT_TOKEN_URL)
        expect(init?.redirect).toBe("error")
        expect(new URLSearchParams(String(init?.body))).toEqual(
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "oaiapp_fake",
            refresh_token: "fake-old-refresh",
            resource: "https://api.openai.com/v1",
          }),
        )
        return Response.json(renewed)
      },
    })
    const pending = await client.refresh(previous, signal())
    expect(await client.verifyRefresh(previous, pending, signal())).toEqual({
      ...previous,
      accessToken: "fake-new-access",
      refreshToken: "fake-new-refresh",
      expiresAt: now + 3600000,
    })
  })

  it.each([
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ])("marks terminal refresh code %s for local credential clearing", async (code) => {
    const client = createChatGPTTokenClient({
      fetchFn: async () =>
        Response.json(
          { error: code, error_description: "fake-secret" },
          { status: 400 },
        ),
    })
    await expect(client.refresh(previous, signal())).rejects.toBeInstanceOf(
      ChatGPTRefreshRevokedError,
    )
  })

  it.each([
    Response.json(
      { error: "invalid_client", description: "fake-secret" },
      { status: 400 },
    ),
    Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
    new Response("fake-secret malformed", { status: 200 }),
    Response.json({ ...renewed, refresh_token: undefined }),
  ])("does not mark temporary or malformed responses as revoked", async (response) => {
    const client = createChatGPTTokenClient({
      fetchFn: async () => response.clone(),
    })
    const attempt = client.refresh(previous, signal())
    await expect(attempt).rejects.toBeInstanceOf(Error)
    await expect(attempt).rejects.not.toBeInstanceOf(ChatGPTRefreshRevokedError)
    await expect(attempt).rejects.not.toThrow("fake-secret")
    await expect(attempt).rejects.not.toThrow("fake-old")
  })

  it("validates refreshed identity and rejects changed subject before returning tokens", async () => {
    const keys = await generateKeyPair("RS256")
    const key = {
      ...(await exportJWK(keys.publicKey)),
      kid: "fake",
      alg: "RS256",
      use: "sig",
    }
    for (const subject of ["subject-a", "different-account"]) {
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "fake" })
        .setIssuer(previous.issuer)
        .setAudience(previous.clientId)
        .setSubject(subject)
        .setIssuedAt(now / 1000)
        .setExpirationTime(now / 1000 + 300)
        .sign(keys.privateKey)
      const client = createChatGPTTokenClient({
        now: () => now,
        fetchFn: async (url) =>
          String(url).endsWith("jwks.json")
            ? Response.json({ keys: [key] })
            : Response.json({ ...renewed, id_token: jwt }),
      })
      const pending = await client.refresh(previous, signal())
      if (subject === previous.subject)
        await expect(
          client.verifyRefresh(previous, pending, signal()),
        ).resolves.toMatchObject({ idToken: jwt })
      else
        await expect(
          client.verifyRefresh(previous, pending, signal()),
        ).rejects.toThrow("identity could not be verified")
    }
  })

  it("recovers a persisted rotation after JWKS outage without consuming another refresh token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yakitori-renewal-fake-"))
    const keys = await generateKeyPair("RS256")
    const key = {
      ...(await exportJWK(keys.publicKey)),
      kid: "fake",
      alg: "RS256",
      use: "sig",
    }
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "fake" })
      .setIssuer(previous.issuer)
      .setAudience(previous.clientId)
      .setSubject(previous.subject)
      .setIssuedAt(now / 1000)
      .setExpirationTime(now / 1000 + 300)
      .sign(keys.privateKey)
    let tokenRequests = 0
    let jwksRequests = 0
    const fetchFn: typeof fetch = async (url) => {
      if (String(url).endsWith("jwks.json"))
        return ++jwksRequests === 1
          ? new Response("temporary fake outage", { status: 503 })
          : Response.json({ keys: [key] })
      expect(String(url)).toBe(CHATGPT_TOKEN_URL)
      tokenRequests++
      return Response.json({ ...renewed, id_token: jwt })
    }
    const createStore = () => {
      const client = createChatGPTTokenClient({ now: () => now, fetchFn })
      return createChatGPTCredentialStore({
        directory,
        now: () => now,
        refresh: client.refresh,
        verifyRefresh: client.verifyRefresh,
      })
    }
    try {
      const store = createStore()
      await store.save(previous)
      await expect(store.resolve(previous)).rejects.toThrow()
      // Protected storage keeps the latest rotating secret while inference
      // stays blocked on signature validation. Restart retries validation only.
      expect(
        await readFile(join(directory, "credentials.json"), "utf8"),
      ).toContain("fake-new-refresh")
      const restarted = createStore()
      await expect(restarted.resolve(previous)).resolves.toMatchObject({
        accessToken: "fake-new-access",
      })
      expect(tokenRequests).toBe(1)
      expect(jwksRequests).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("preserves an unresolved identity check when later rotations omit their ID token", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "yakitori-identity-renewal-fake-"),
    )
    const keys = await generateKeyPair("RS256")
    const key = {
      ...(await exportJWK(keys.publicKey)),
      kid: "fake",
      alg: "RS256",
      use: "sig",
    }
    let clock = now
    const submittedRefreshTokens: string[] = []
    const signed = (subject: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "fake" })
        .setIssuer(previous.issuer)
        .setAudience(previous.clientId)
        .setSubject(subject)
        .setIssuedAt(clock / 1000)
        .setExpirationTime(clock / 1000 + 300)
        .sign(keys.privateKey)
    const fetchFn: typeof fetch = async (url, init) => {
      if (String(url).endsWith("jwks.json"))
        return Response.json({ keys: [key] })
      expect(String(url)).toBe(CHATGPT_TOKEN_URL)
      const form = new URLSearchParams(String(init?.body))
      expect(form.get("client_id")).toBe(previous.clientId)
      submittedRefreshTokens.push(form.get("refresh_token") ?? "")
      const n = submittedRefreshTokens.length
      return Response.json({
        ...renewed,
        access_token: `fake-access-${n}`,
        refresh_token: `fake-refresh-${n}`,
        ...(n === 2
          ? {}
          : {
              id_token: await signed(
                n === 1 ? "different-account" : previous.subject,
              ),
            }),
      })
    }
    const createStore = () => {
      const client = createChatGPTTokenClient({ now: () => clock, fetchFn })
      return createChatGPTCredentialStore({
        directory,
        now: () => clock,
        refresh: client.refresh,
        verifyRefresh: client.verifyRefresh,
      })
    }
    try {
      const store = createStore()
      await store.save(previous)
      await expect(store.resolve(previous)).rejects.toThrow()
      clock += 3601000
      // A fresh access token without new identity evidence must not erase the
      // earlier wrong-subject failure or fall back to the old validated hint.
      await expect(createStore().resolve(previous)).rejects.toThrow(
        "identity_verification_required",
      )
      await expect(createStore().resolve(previous)).resolves.toMatchObject({
        accessToken: "fake-access-3",
      })
      expect(submittedRefreshTokens).toEqual([
        "fake-old-refresh",
        "fake-refresh-1",
        "fake-refresh-2",
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("marks an expired pending ID token for renewal without accepting it", async () => {
    const keys = await generateKeyPair("RS256")
    const key = {
      ...(await exportJWK(keys.publicKey)),
      kid: "fake",
      alg: "RS256",
      use: "sig",
    }
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "fake" })
      .setIssuer(previous.issuer)
      .setAudience(previous.clientId)
      .setSubject(previous.subject)
      .setIssuedAt(now / 1000 - 60)
      .setExpirationTime(now / 1000 - 10)
      .sign(keys.privateKey)
    const client = createChatGPTTokenClient({
      now: () => now,
      fetchFn: async (url) =>
        String(url).endsWith("jwks.json")
          ? Response.json({ keys: [key] })
          : Response.json({ ...renewed, id_token: jwt }),
    })
    const pending = await client.refresh(previous, signal())
    await expect(
      client.verifyRefresh(previous, pending, signal()),
    ).rejects.toBeInstanceOf(ChatGPTPendingRenewalExpiredError)
  })

  it("stops plan usage after a narrowed refresh grant", async () => {
    const client = createChatGPTTokenClient({
      fetchFn: async () => Response.json({ ...renewed, scope: "openid" }),
    })
    await expect(client.refresh(previous, signal())).rejects.toBeInstanceOf(
      ChatGPTRefreshRevokedError,
    )
  })

  it("discovers trusted revocation, retries one temporary error, and accepts empty 200", async () => {
    let posts = 0
    const client = createChatGPTTokenClient({
      fetchFn: async (url, init) => {
        expect(init?.redirect).toBe("error")
        if (String(url).endsWith("openid-configuration"))
          return Response.json({
            issuer: previous.issuer,
            revocation_endpoint: `${previous.issuer}/api/accounts/oauth/revoke`,
          })
        expect(String(url)).toBe(`${previous.issuer}/api/accounts/oauth/revoke`)
        expect(new URLSearchParams(String(init?.body))).toEqual(
          new URLSearchParams({
            token: previous.refreshToken,
            token_type_hint: "refresh_token",
            client_id: previous.clientId,
          }),
        )
        return ++posts === 1
          ? new Response("", { status: 503 })
          : new Response("", { status: 200 })
      },
    })
    await client.revoke(previous, signal())
    expect(posts).toBe(2)
  })

  it.each([
    "https://attacker.invalid/revoke",
    "http://auth.openai.com/revoke",
    "https://auth.openai.com/revoke?token=x",
  ])("never transmits credentials to invalid discovered endpoint %s", async (endpoint) => {
    let calls = 0
    const client = createChatGPTTokenClient({
      fetchFn: async () => {
        calls++
        return Response.json({
          issuer: previous.issuer,
          revocation_endpoint: endpoint,
        })
      },
    })
    await expect(client.revoke(previous, signal())).rejects.toThrow(
      "endpoint is invalid",
    )
    expect(calls).toBe(1)
  })

  it("bounds failed revocation and does not retry permanent rejection", async () => {
    for (const status of [400, 503]) {
      let posts = 0
      const client = createChatGPTTokenClient({
        fetchFn: async (url) => {
          if (String(url).endsWith("openid-configuration"))
            return Response.json({
              issuer: previous.issuer,
              revocation_endpoint: `${previous.issuer}/revoke`,
            })
          posts++
          return new Response("fake-secret", { status })
        },
      })
      await expect(client.revoke(previous, signal())).rejects.toThrow(/ChatGPT/)
      expect(posts).toBe(status === 400 ? 1 : 2)
    }
  })
})
