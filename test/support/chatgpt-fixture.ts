import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { CHATGPT_TOKEN_URL } from "../../src/server/chatgpt-oauth.ts"

const keys = await generateKeyPair("RS256")
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: "fake-siwc",
  alg: "RS256",
  use: "sig",
}
export function createChatGPTFixture() {
  let authorization: URL | undefined
  let clientNumber = 0
  let status = 200
  let scopes =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
  let beforeExchange: (() => Promise<void>) | undefined
  let revokeStatus = 200
  const requests: string[] = []
  const fetchFn: typeof fetch = async (url, init) => {
    const target = String(url)
    requests.push(target)
    if (target === "https://auth.openai.com/.well-known/jwks.json")
      return Response.json({ keys: [jwk] })
    if (target === "https://auth.openai.com/.well-known/openid-configuration")
      return Response.json({
        issuer: "https://auth.openai.com",
        revocation_endpoint: "https://auth.openai.com/revoke",
      })
    if (target === "https://auth.openai.com/revoke")
      return new Response(null, { status: revokeStatus })
    if (target === "https://api.openai.com/v1/models")
      return Response.json({
        models: [
          {
            slug: "fixture-model",
            display_name: "Fixture model",
            visibility: "list",
          },
        ],
      })
    if (target !== CHATGPT_TOKEN_URL || !authorization)
      throw new Error("Unexpected fake SIWC request.")
    const captured = authorization
    const body = new URLSearchParams(String(init?.body))
    await beforeExchange?.()
    if (status !== 200)
      return Response.json({ error: "fixture_error" }, { status })
    const jwt = await new SignJWT({
      nonce: captured.searchParams.get("nonce"),
      email: "same@example.test",
    })
      .setProtectedHeader({ alg: "RS256", kid: "fake-siwc" })
      .setIssuer("https://auth.openai.com")
      .setAudience(body.get("client_id") ?? "")
      .setSubject("fixture-subject")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keys.privateKey)
    return Response.json({
      token_type: "Bearer",
      id_token: jwt,
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      scope: scopes,
      expires_in: 3600,
    })
  }
  return {
    fetchFn,
    requests,
    async openAuthorization(url: string) {
      authorization = new URL(url)
    },
    get authorization() {
      if (!authorization) throw new Error("No fake authorization started.")
      return authorization
    },
    callback(updates: Record<string, string> = {}) {
      if (!authorization) throw new Error("No fake authorization started.")
      const callback = new URL(
        authorization.searchParams.get("redirect_uri") ?? "",
      )
      const requested = authorization.searchParams.get("client_id")
      callback.search = new URLSearchParams({
        code: "fixture-code",
        state: authorization.searchParams.get("state") ?? "",
        client_id:
          requested === "dynamic_agent_client"
            ? `oaiapp_fixture_${++clientNumber}`
            : (requested ?? ""),
        ...updates,
      }).toString()
      return callback.href
    },
    exchangeStatus(value: number) {
      status = value
    },
    permissions(value: string) {
      scopes = value
    },
    beforeExchange(value: () => Promise<void>) {
      beforeExchange = value
    },
    revokeStatus(value: number) {
      revokeStatus = value
    },
  }
}
