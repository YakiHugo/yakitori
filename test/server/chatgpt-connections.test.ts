import { promises } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { Server } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createChatGPTConnections } from "../../src/server/chatgpt-connections.ts"
import { createChatGPTFixture } from "../support/chatgpt-fixture.ts"
import { deferred } from "./rpc/testkit.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-siwc-connections-"))
  const protocol = createChatGPTFixture()
  const service = createChatGPTConnections({
    directory,
    fetchFn: protocol.fetchFn,
    openAuthorization: protocol.openAuthorization,
  })
  cleanups.push(
    () => rm(directory, { recursive: true, force: true }),
    () => service.close(),
  )
  return { service, directory, protocol }
}
async function complete(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await fetch(f.protocol.callback())
  expect(response.status).toBe(200)
  return f.service.read()
}

describe("ChatGPT connection lifecycle", () => {
  it("binds a real loopback before browser launch, persists registration before exchange and exposes no secrets", async () => {
    const f = await fixture()
    const first = await f.service.signIn({ label: "Personal" })
    expect(first.attempt?.state).toBe("waiting")
    const hostId =
      f.protocol.authorization.searchParams.get("ext_agent_host_id")
    expect(
      JSON.parse(
        await readFile(join(f.directory, "auth/credentials.json"), "utf8"),
      ).hostId,
    ).toBe(hostId)
    f.protocol.beforeExchange(async () => {
      const saved = JSON.parse(
        await readFile(join(f.directory, "connections.json"), "utf8"),
      )
      expect(saved.accounts[0].pendingClientId).toBe("oaiapp_fixture_1")
      expect(saved.accounts[0].identity).toBeUndefined()
    })
    const result = await complete(f)
    expect(result.accounts).toEqual([
      {
        id: first.accounts[0]?.id,
        label: "Personal",
        providerId: first.accounts[0]?.providerId,
        email: "same@example.test",
        state: "connected",
      },
    ])
    expect(result.welcomeRequired).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-access|fixture-refresh|id_token|authorization|oaiapp_/,
    )
    await f.service.acknowledge()
    expect((await f.service.read()).welcomeRequired).toBe(false)
  })

  it("rejects unrelated callback traffic without consuming the valid attempt", async () => {
    const f = await fixture()
    await f.service.signIn({})
    const valid = f.protocol.callback()
    const invalid = new URL(valid)
    invalid.searchParams.set("state", "wrong-state")
    expect((await fetch(invalid)).status).toBe(400)
    expect((await f.service.read()).attempt?.state).toBe("waiting")
    expect((await fetch(valid)).status).toBe(200)
    expect((await f.service.read()).accounts[0]?.state).toBe("connected")
  })

  it("cancels a pending listener and ignores completion after cancellation", async () => {
    const f = await fixture()
    const exchange = deferred<void>()
    const entered = deferred<void>()
    f.protocol.beforeExchange(async () => {
      entered.resolve()
      await exchange.promise
    })
    const initial = await f.service.signIn({})
    const callback = f.protocol.callback()
    const response = fetch(callback).catch(() => undefined)
    await entered.promise
    await f.service.cancel(initial.attempt?.id ?? "")
    exchange.resolve()
    await response
    expect((await f.service.read()).attempt?.state).toBe("cancelled")
    expect(await f.service.available()).toEqual([])
    await expect(fetch(callback)).rejects.toThrow()
  })

  it("reuses pending issued registration on a later sign-in without treating it as identity", async () => {
    const f = await fixture()
    f.protocol.exchangeStatus(500)
    const initial = await f.service.signIn({})
    await complete(f)
    expect((await f.service.read()).attempt?.state).toBe("failed")
    expect(await f.service.available()).toEqual([])
    f.protocol.exchangeStatus(200)
    await f.service.signIn({ accountId: initial.accounts[0]?.id ?? "" })
    expect(f.protocol.authorization.searchParams.get("client_id")).toBe(
      "oaiapp_fixture_1",
    )
    expect(f.protocol.authorization.searchParams.has("id_token_hint")).toBe(
      false,
    )
    expect((await complete(f)).accounts[0]?.state).toBe("connected")
  })

  it("keeps identity-only connections disabled and separate registrations with matching email selectable", async () => {
    const f = await fixture()
    f.protocol.permissions("openid profile email")
    await f.service.signIn({ label: "Identity" })
    const identity = await complete(f)
    expect(identity.accounts[0]?.state).toBe("identity_only")
    expect(await f.service.available()).toEqual([])
    f.protocol.permissions(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    )
    await f.service.signIn({ label: "Personal" })
    await complete(f)
    await f.service.signIn({ label: "Work" })
    const result = await complete(f)
    expect(result.accounts.map((a) => [a.label, a.state])).toEqual([
      ["Identity", "identity_only"],
      ["Personal", "connected"],
      ["Work", "connected"],
    ])
    expect(
      new Set((await f.service.available()).map((a) => a.identity.clientId))
        .size,
    ).toBe(2)
    await expect(f.service.signIn({ label: "Work" })).rejects.toThrow(
      "distinct",
    )
  })

  it("stops account requests on signout and retains unconfirmed remote revocation through restart", async () => {
    const f = await fixture()
    await f.service.signIn({})
    const connected = await complete(f)
    const account = (await f.service.available())[0]
    if (!account) throw new Error("Missing fixture account")
    const token = await f.service.resolve(account.identity)
    f.protocol.revokeStatus(400)
    const signedOut = await f.service.signOut(connected.accounts[0]?.id ?? "")
    expect(token.signal.aborted).toBe(true)
    expect(signedOut.accounts[0]).toMatchObject({
      state: "signed_out",
      remoteRevocation: "unconfirmed",
    })
    expect(await f.service.available()).toEqual([])
    const restarted = createChatGPTConnections({
      directory: f.directory,
      fetchFn: f.protocol.fetchFn,
      openAuthorization: f.protocol.openAuthorization,
    })
    cleanups.push(() => restarted.close())
    expect((await restarted.read()).accounts[0]?.remoteRevocation).toBe(
      "unconfirmed",
    )
    await restarted.signIn({ accountId: connected.accounts[0]?.id ?? "" })
    expect(f.protocol.authorization.searchParams.get("client_id")).toBe(
      account.identity.clientId,
    )
  })

  it("shutdown closes a pending loopback and aborts active account signals without signing out", async () => {
    const f = await fixture()
    await f.service.signIn({})
    await complete(f)
    const account = (await f.service.available())[0]
    if (!account) throw new Error("Missing fixture account")
    const token = await f.service.resolve(account.identity)
    await f.service.signIn({ label: "Another" })
    const callback = f.protocol.callback()
    await f.service.close()
    expect(token.signal.aborted).toBe(true)
    await expect(fetch(callback)).rejects.toThrow()
    expect((await f.service.read()).accounts[0]?.state).toBe("connected")
  })
  it.each([
    true,
    false,
  ])("cleans up after a %s identity-only persistence failure and permits retry", async (identityOnly) => {
    const f = await fixture()
    if (identityOnly) f.protocol.permissions("openid profile email")
    const initial = await f.service.signIn({})
    const metadataPath = join(f.directory, "connections.json")
    let saved = ""
    f.protocol.beforeExchange(async () => {
      saved = await readFile(metadataPath, "utf8")
      await rm(metadataPath)
      await mkdir(metadataPath)
    })
    const callback = f.protocol.callback()
    expect((await fetch(callback)).status).toBe(200)
    await rm(metadataPath, { recursive: true })
    await writeFile(metadataPath, saved)
    expect((await f.service.read()).attempt?.state).toBe("failed")
    expect(
      (await f.service.cancel(initial.attempt?.id ?? "")).attempt?.state,
    ).toBe("failed")
    await expect(fetch(callback)).rejects.toThrow()
    f.protocol.beforeExchange(async () => {})
    f.protocol.permissions(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    )
    await f.service.signIn({ accountId: initial.accounts[0]?.id ?? "" })
    expect((await complete(f)).accounts[0]?.state).toBe("connected")
  })
  it("does not let delayed cancellation overwrite a newer browser attempt", async () => {
    const f = await fixture()
    const first = await f.service.signIn({ label: "First" })
    const closed = deferred<void>()
    const release = deferred<void>()
    const originalClose = Server.prototype.close
    const spy = vi
      .spyOn(Server.prototype, "close")
      .mockImplementationOnce(function (this: Server, callback) {
        return originalClose.call(this, (error) => {
          closed.resolve()
          void release.promise.then(() => callback?.(error))
        })
      })
    try {
      const cancelling = f.service.cancel(first.attempt?.id ?? "")
      await closed.promise
      const second = await f.service.signIn({ label: "Second" })
      release.resolve()
      expect((await cancelling).attempt?.id).toBe(second.attempt?.id)
      expect((await f.service.read()).attempt?.state).toBe("waiting")
      expect((await complete(f)).attempt?.id).toBe(second.attempt?.id)
    } finally {
      release.resolve()
      spy.mockRestore()
    }
  })
  it("disables an old plan grant after a verified identity-only reconnect and explicitly requests consent to upgrade", async () => {
    const f = await fixture()
    await f.service.signIn({ label: "Personal" })
    const first = await complete(f)
    const identity = (await f.service.available())[0]?.identity
    if (!identity) throw new Error("Missing fixture identity")
    const activeToken = await f.service.resolve(identity)
    await f.service.signIn({ accountId: first.accounts[0]?.id ?? "" })
    expect(f.protocol.authorization.searchParams.has("prompt")).toBe(false)
    f.protocol.permissions("openid profile email")
    const disabled = await complete(f)
    expect(disabled.accounts[0]?.state).toBe("identity_only")
    expect(activeToken.signal.aborted).toBe(true)
    expect(await f.service.available()).toEqual([])
    await expect(f.service.resolve(identity)).rejects.toMatchObject({
      code: "signed_out",
    })
    await f.service.signIn({ accountId: first.accounts[0]?.id ?? "" })
    expect(f.protocol.authorization.searchParams.get("client_id")).toBe(
      identity.clientId,
    )
    expect(f.protocol.authorization.searchParams.get("prompt")).toBe("consent")
    expect(f.protocol.authorization.searchParams.has("force_reconsent")).toBe(
      false,
    )
    expect(f.protocol.authorization.searchParams.get("scope")).toContain(
      "chatgpt.tokens.use.direct",
    )
  })

  it.each([
    true,
    false,
  ])("preserves a completed callback when the launcher fails during commit (identity-only %s)", async (identityOnly) => {
    const f = await fixture()
    let rejectLaunch: ((error: Error) => void) | undefined
    const launch = new Promise<void>((_resolve, reject) => {
      rejectLaunch = reject
    })
    const service = createChatGPTConnections({
      directory: f.directory,
      fetchFn: f.protocol.fetchFn,
      async openAuthorization(url) {
        await f.protocol.openAuthorization(url)
        await launch
      },
    })
    cleanups.push(() => service.close())
    if (identityOnly) f.protocol.permissions("openid profile email")
    await service.signIn({ label: "Late launcher" })
    const entered = deferred<void>()
    const release = deferred<void>()
    const originalRename = promises.rename
    const spy = vi
      .spyOn(promises, "rename")
      .mockImplementation(async (from, to) => {
        if (String(to) === join(f.directory, "connections.json")) {
          const document = JSON.parse(await readFile(from, "utf8"))
          if (document.accounts[0]?.identity) {
            entered.resolve()
            await release.promise
          }
        }
        await originalRename(from, to)
      })
    syncBuiltinESMExports()
    try {
      const callback = fetch(f.protocol.callback())
      await entered.promise
      rejectLaunch?.(new Error("Fixture launcher timeout"))
      await new Promise<void>((resolve) => setImmediate(resolve))
      release.resolve()
      expect((await callback).status).toBe(200)
      expect((await service.read()).attempt?.state).toBe(
        identityOnly ? "identity_only" : "succeeded",
      )
    } finally {
      release.resolve()
      spy.mockRestore()
      syncBuiltinESMExports()
    }
  })
})
