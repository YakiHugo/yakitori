import { createChatGPTConnections } from "../../src/server/chatgpt-connections.ts"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createYakitoriApplication } from "../../src/server/application.ts"
import { createChatGPTFixture } from "../support/chatgpt-fixture.ts"
import { createChatGPTRpcClient } from "../support/chatgpt-rpc-client.ts"

it("routes verified ChatGPT accounts through live RPC/model selection and removes disconnected providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-siwc-app-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const protocol = createChatGPTFixture()
  let modelsUnavailable = false
  const application = await createYakitoriApplication({
    rootDir: join(root, "store"),
    workspace,
    userConfigPath: join(root, "config.toml"),
    provider: "faux",
    chatgpt: {
      fetchFn: (url, init) =>
        modelsUnavailable && String(url) === "https://api.openai.com/v1/models"
          ? Promise.resolve(new Response(null, { status: 403 }))
          : protocol.fetchFn(url, init),
      openAuthorization: protocol.openAuthorization,
    },
  })
  const server = application.createHttpServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port")
  const rpc = await createChatGPTRpcClient(`http://127.0.0.1:${address.port}`)
  try {
    expect((await rpc.request("chatgpt/read", {})).accounts).toEqual([])
    const initial = await rpc.request("chatgpt/signIn", { label: "Personal" })
    expect(initial.attempt?.state).toBe("waiting")
    expect((await fetch(protocol.callback())).status).toBe(200)
    const state = await rpc.request("chatgpt/read", {})
    const account = state.accounts[0]
    if (!account) throw new Error("Missing fixture account")
    const providers = await rpc.request("provider/list", {})
    expect(
      providers.providers.find((p) => p.name === account.providerId),
    ).toMatchObject({
      displayName: "Personal",
      credentialKind: "oauth",
      availability: "available",
      models: [{ id: "fixture-model", displayName: "Fixture model" }],
    })
    modelsUnavailable = true
    const partial = await rpc.request("provider/list", {})
    expect(
      partial.providers.find((p) => p.name === "faux")?.models.length,
    ).toBeGreaterThan(0)
    expect(
      partial.providers.find((p) => p.name === account.providerId),
    ).toMatchObject({
      models: [],
      catalogError:
        "ChatGPT models are unavailable. Retry or reconnect this account.",
    })
    modelsUnavailable = false
    await rpc.request("chatgpt/signOut", { accountId: account.id })
    const signedOut = await rpc.request("provider/list", {})
    expect(
      signedOut.providers.find((p) => p.name === account.providerId),
    ).toMatchObject({ availability: "requires_login", models: [] })
    expect(rpc.frames.join("\n")).not.toMatch(
      /fixture-access|fixture-refresh|id_token_hint|dynamic_agent_client|api\/accounts\/authorize/,
    )
    const otherOwner = createChatGPTConnections({
      directory: join(root, "chatgpt-connections"),
      fetchFn: protocol.fetchFn,
      openAuthorization: protocol.openAuthorization,
    })
    try {
      await otherOwner.signIn({ label: "Other app" })
      expect((await fetch(protocol.callback())).status).toBe(200)
      const externallyConnected = (await otherOwner.read()).accounts.find(
        (account) => account.label === "Other app",
      )
      const refreshed = await rpc.request("provider/list", {})
      expect(
        refreshed.providers.find(
          (provider) => provider.name === externallyConnected?.providerId,
        ),
      ).toMatchObject({
        availability: "available",
        models: [{ id: "fixture-model" }],
      })
    } finally {
      await otherOwner.close()
    }
    const newAttempt = await rpc.request("chatgpt/signIn", { label: "Another" })
    expect(newAttempt.attempt?.state).toBe("waiting")
    const pendingCallback = protocol.callback()
    rpc.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await application.close()
    await expect(fetch(pendingCallback)).rejects.toThrow()
  } finally {
    rpc.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it("returns cancellable attempts over live RPC while the system-browser launcher is still pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-siwc-launch-"))
  const protocol = createChatGPTFixture()
  const launches: { url: string; signal?: AbortSignal }[] = []
  const application = await createYakitoriApplication({
    rootDir: join(root, "store"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "faux",
    chatgpt: {
      fetchFn: protocol.fetchFn,
      async openAuthorization(url, signal) {
        launches.push({ url, ...(signal === undefined ? {} : { signal }) })
        await protocol.openAuthorization(url)
        // Model a launcher that stays pending until its owner aborts it.
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        )
      },
    },
  })
  const server = application.createHttpServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port")
  const rpc = await createChatGPTRpcClient(`http://127.0.0.1:${address.port}`)
  try {
    const first = await rpc.request("chatgpt/signIn", { label: "Slow launch" })
    expect(first.attempt?.state).toBe("waiting")
    expect(launches[0]?.signal?.aborted).toBe(false)
    const firstCallback = protocol.callback()
    expect((await rpc.request("chatgpt/read", {})).attempt?.id).toBe(
      first.attempt?.id,
    )
    const canceled = await rpc.request("chatgpt/cancel", {
      attemptId: first.attempt?.id ?? "",
    })
    expect(canceled.attempt?.state).toBe("cancelled")
    expect(launches[0]?.signal?.aborted).toBe(true)
    await expect(fetch(firstCallback)).rejects.toThrow()
    const next = await rpc.request("chatgpt/signIn", { label: "Next launch" })
    expect(next.attempt?.state).toBe("waiting")
    expect(next.attempt?.id).not.toBe(first.attempt?.id)
    const secondCallback = protocol.callback()
    rpc.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await application.close()
    expect(launches[1]?.signal?.aborted).toBe(true)
    await expect(fetch(secondCallback)).rejects.toThrow()
    expect(rpc.frames.join("\n")).not.toMatch(
      /api\/accounts\/authorize|id_token_hint|fixture-access|fixture-refresh/,
    )
  } finally {
    rpc.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await application.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
