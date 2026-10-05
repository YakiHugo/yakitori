import { spawn } from "node:child_process"
import { promises } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flock } from "fs-ext"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createChatGPTCredentialStore,
  ChatGPTRefreshRevokedError,
  ChatGPTPendingRenewalExpiredError,
  type ChatGPTPendingRenewal,
} from "../../src/server/chatgpt-credential-store.ts"
import type { ChatGPTCredentials } from "../../src/server/chatgpt-oauth.ts"

const now = 1_800_000_000_000
const credentials: ChatGPTCredentials = {
  issuer: "https://auth.openai.com",
  clientId: "oaiapp_fake",
  subject: "subject-a",
  email: "a@example.invalid",
  idToken: "fake-private-id",
  accessToken: "fake-private-access",
  refreshToken: "fake-private-refresh",
  scopes: ["openid", "resource.invoke", "chatgpt.tokens.use.direct"],
  expiresAt: now + 60_000,
}
const replacement = {
  ...credentials,
  idToken: "fake-rotated-id",
  accessToken: "fake-rotated-access",
  refreshToken: "fake-rotated-refresh",
  expiresAt: now + 120_000,
}
const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function fixture(
  options: Partial<Parameters<typeof createChatGPTCredentialStore>[0]> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-siwc-fake-"))
  directories.push(directory)
  const input = {
    directory,
    now: () => now,
    refresh: vi.fn(async () => replacement),
    verifyRefresh: vi.fn(
      async (previous: ChatGPTCredentials, pending: ChatGPTPendingRenewal) => ({
        ...previous,
        ...pending,
        idToken: pending.idToken ?? previous.idToken,
      }),
    ),
    ...options,
  }
  return { directory, input, store: createChatGPTCredentialStore(input) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function contents(directory: string) {
  return readFile(join(directory, "credentials.json"), "utf8")
}

describe("server-only SIWC credential lifecycle", () => {
  it("persists one host ID across owners before credentials exist with owner-only files", async () => {
    const { directory, input, store } = await fixture()
    const other = createChatGPTCredentialStore(input)
    const hosts = await Promise.all([store.hostId(), other.hostId()])
    expect(hosts[0]).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(hosts[1]).toBe(hosts[0])
    expect(JSON.parse(await contents(directory))).toEqual({
      version: 1,
      hostId: hosts[0],
      accounts: [],
    })
    expect(await createChatGPTCredentialStore(input).hostId()).toBe(hosts[0])
    for (const [path, mode] of [
      [directory, 0o700],
      [join(directory, "credentials.json"), 0o600],
      [join(directory, "store.lock"), 0o600],
    ] as const) {
      const file = await open(path, "r")
      try {
        expect((await file.stat()).mode & 0o777).toBe(mode)
      } finally {
        await file.close()
      }
    }
  })

  it("separates both client ID and verified subject and exposes token-free summaries", async () => {
    const { store } = await fixture()
    const otherSubject = {
      ...credentials,
      subject: "subject-b",
      accessToken: "fake-b",
    }
    const otherClient = {
      ...credentials,
      clientId: "oaiapp_second",
      accessToken: "fake-c",
    }
    await store.save(credentials)
    await store.save(otherSubject)
    await store.save(otherClient)
    expect((await store.resolve(credentials)).accessToken).toBe(
      credentials.accessToken,
    )
    expect((await store.resolve(otherSubject)).accessToken).toBe("fake-b")
    expect((await store.resolve(otherClient)).accessToken).toBe("fake-c")
    const summaries = await store.summaries()
    expect(summaries).toHaveLength(3)
    expect(Object.keys(summaries[0] ?? {}).sort()).toEqual([
      "clientId",
      "email",
      "expiresAt",
      "signedIn",
      "subject",
    ])
    for (const token of [
      credentials.idToken,
      credentials.accessToken,
      credentials.refreshToken,
    ])
      expect(JSON.stringify(summaries)).not.toContain(token)
    await store.signOut(credentials)
    expect((await store.resolve(otherSubject)).accessToken).toBe("fake-b")
    expect((await store.resolve(otherClient)).accessToken).toBe("fake-c")
  })

  it("serializes two store owners and persists rotated credentials before returning access", async () => {
    const entered = deferred()
    const release = deferred()
    const refresh = vi.fn(async (source: ChatGPTCredentials) => {
      expect(source.refreshToken).toBe(credentials.refreshToken)
      entered.resolve()
      await release.promise
      return replacement
    })
    const { directory, store, input } = await fixture({ refresh })
    await store.save({ ...credentials, expiresAt: now - 1 })
    const first = store.resolve(credentials)
    await entered.promise
    const second = createChatGPTCredentialStore(input).resolve(credentials)
    release.resolve()
    const tokens = await Promise.all([first, second])
    expect(tokens.map((token) => token.accessToken)).toEqual([
      replacement.accessToken,
      replacement.accessToken,
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(await contents(directory)).accounts[0].credentials,
    ).toEqual(replacement)
    expect(
      (await createChatGPTCredentialStore(input).resolve(credentials))
        .accessToken,
    ).toBe(replacement.accessToken)
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([])
  })

  it("uses operating-system locks to serialize refresh across independent processes", async () => {
    const { directory, store } = await fixture()
    await store.save({ ...credentials, expiresAt: now - 1 })
    const source = new URL(
      "../../src/server/chatgpt-credential-store.ts",
      import.meta.url,
    ).href
    const script = `
      import { appendFile } from "node:fs/promises";
      import { join } from "node:path";
      import { createChatGPTCredentialStore, ChatGPTRefreshRevokedError } from ${JSON.stringify(source)};
      const directory = process.argv[1];
      const store = createChatGPTCredentialStore({ directory, now: () => ${now}, refresh: async () => {
        await appendFile(join(directory, "fake-refresh-calls"), "refresh\\n");
        process.stdout.write("refreshing\\n");
        await new Promise(resolve => setTimeout(resolve, 150));
        return ${JSON.stringify(replacement)};
      }, verifyRefresh: async (previous, pending) => ({ ...previous, ...pending, idToken: pending.idToken ?? previous.idToken }) });
      const result = await store.resolve(${JSON.stringify({ clientId: credentials.clientId, subject: credentials.subject })});
      process.stdout.write(result.accessToken + "\\n");
    `
    const run = () => {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        directory,
      ])
      let stdout = ""
      let stderr = ""
      const entered = deferred()
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.includes("refreshing")) entered.resolve()
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const complete = new Promise<string>((resolve, reject) => {
        child.on("error", reject)
        child.on("close", (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(stderr)),
        )
      })
      return { complete, entered: entered.promise }
    }
    const first = run()
    await Promise.race([first.entered, first.complete])
    const second = run()
    for (const output of await Promise.all([first.complete, second.complete]))
      expect(output).toContain(replacement.accessToken)
    expect(await readFile(join(directory, "fake-refresh-calls"), "utf8")).toBe(
      "refresh\n",
    )
  })

  it("signout aborts local requests immediately, removes secrets, and retains reauthorization identity", async () => {
    const revokeEntered = deferred()
    const releaseRevoke = deferred()
    const revoke = vi.fn(async (source: ChatGPTCredentials) => {
      expect(source.refreshToken).toBe(credentials.refreshToken)
      revokeEntered.resolve()
      await releaseRevoke.promise
    })
    const { directory, store, input } = await fixture({ revoke })
    const host = await store.hostId()
    await store.save(credentials)
    const access = await store.resolve(credentials)
    expect(access).toMatchObject({
      clientId: credentials.clientId,
      subject: credentials.subject,
    })
    const signingOut = store.signOut(credentials)
    expect(access.signal.aborted).toBe(true)
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "signed_out",
    })
    await revokeEntered.promise
    const persisted = await contents(directory)
    for (const token of [
      credentials.idToken,
      credentials.accessToken,
      credentials.refreshToken,
    ])
      expect(persisted).not.toContain(token)
    expect(await store.registration(credentials)).toEqual({
      clientId: credentials.clientId,
      subject: credentials.subject,
      email: credentials.email,
    })
    await expect(
      createChatGPTCredentialStore(input).resolve(credentials),
    ).rejects.toMatchObject({ code: "signed_out" })
    releaseRevoke.resolve()
    expect(await signingOut).toEqual({ revocation: "revoked" })
    expect(await store.hostId()).toBe(host)
    await store.save(replacement)
    const reauthorized = await store.resolve(credentials)
    expect(reauthorized.signal.aborted).toBe(false)
    expect(reauthorized.accessToken).toBe(replacement.accessToken)
    expect(access.signal.aborted).toBe(true)
  })

  it("does not resurrect credentials when another owner signs out during refresh", async () => {
    const entered = deferred()
    const release = deferred()
    const { directory, store, input } = await fixture({
      refresh: async () => {
        entered.resolve()
        await release.promise
        return replacement
      },
    })
    await store.save({ ...credentials, expiresAt: now - 1 })
    const pending = store.resolve(credentials)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "signed_out",
    })
    await entered.promise
    await createChatGPTCredentialStore(input).signOut(credentials)
    release.resolve()
    await rejected
    expect(await contents(directory)).not.toContain(replacement.accessToken)
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "signed_out",
    })
  })

  it("aborts local refresh immediately and ignores a late callback that disregards cancellation", async () => {
    const entered = deferred()
    const release = deferred()
    let signal: AbortSignal | undefined
    const { directory, store } = await fixture({
      refresh: async (_source, currentSignal) => {
        signal = currentSignal
        entered.resolve()
        await release.promise
        return replacement
      },
    })
    await store.save({ ...credentials, expiresAt: now - 1 })
    const pending = store.resolve(credentials)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "refresh_failed",
    })
    await entered.promise
    await store.signOut(credentials)
    expect(signal?.aborted).toBe(true)
    await rejected
    release.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await contents(directory)).not.toContain(replacement.accessToken)
  })

  it("never overwrites a newer sign-in when an older refresh finishes", async () => {
    const entered = deferred()
    const release = deferred()
    const { directory, store, input } = await fixture({
      refresh: async () => {
        entered.resolve()
        await release.promise
        return replacement
      },
    })
    await store.save({ ...credentials, expiresAt: now - 1 })
    const pending = store.resolve(credentials)
    const rejected = expect(pending).rejects.toMatchObject({
      code: "credentials_changed",
    })
    await entered.promise
    const latest = {
      ...replacement,
      accessToken: "fake-newer-signin",
      refreshToken: "fake-newer-refresh",
    }
    await createChatGPTCredentialStore(input).save(latest)
    release.resolve()
    await rejected
    expect(
      JSON.parse(await contents(directory)).accounts[0].credentials,
    ).toEqual(latest)
  })

  it("leaves credentials unchanged and redacts callback errors", async () => {
    const { directory, store } = await fixture({
      refresh: async () => {
        throw new Error(`provider leaked ${credentials.refreshToken}`)
      },
    })
    await store.save(credentials)
    const before = await contents(directory)
    const error = await store
      .resolve(credentials, { forceRefresh: true })
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: "refresh_failed" })
    expect(String(error)).not.toContain(credentials.refreshToken)
    expect(error).not.toHaveProperty("cause")
    const after = JSON.parse(await contents(directory)).accounts[0]
    expect(after.credentials).toEqual(
      JSON.parse(before).accounts[0].credentials,
    )
    expect(after.refreshOutcomeUnknown).toBe(true)
  })

  it.each([
    { ...replacement, subject: "unexpected-subject" },
    { ...replacement, clientId: "oaiapp_wrong" },
    { ...replacement, scopes: ["openid"] },
    { ...replacement, refreshToken: "" },
    { ...replacement, expiresAt: now - 1 },
  ])("rejects an invalid replacement without overwriting durable credentials %#", async (next) => {
    const { directory, store } = await fixture({
      verifyRefresh: async () => next,
    })
    await store.save(credentials)
    const before = await contents(directory)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "invalid_credentials" })
    expect(
      JSON.parse(await contents(directory)).accounts[0].credentials,
    ).toEqual(JSON.parse(before).accounts[0].credentials)
  })

  it("bounds hung callbacks and does not persist their late result", async () => {
    const release = deferred()
    let signal: AbortSignal | undefined
    const { directory, store } = await fixture({
      callbackTimeoutMs: 20,
      refresh: async (_source, currentSignal) => {
        signal = currentSignal
        await release.promise
        return replacement
      },
    })
    await store.save(credentials)
    const before = await contents(directory)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "refresh_failed" })
    expect(signal?.aborted).toBe(true)
    release.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const after = JSON.parse(await contents(directory)).accounts[0]
    expect(after.credentials).toEqual(
      JSON.parse(before).accounts[0].credentials,
    )
    expect(after.refreshOutcomeUnknown).toBe(true)
  })

  it("bounds lock contention without replacing the lock inode or changing credentials", async () => {
    const { directory, input, store } = await fixture({ lockTimeoutMs: 20 })
    await store.save(credentials)
    const file = await open(join(directory, "store.lock"), "r+")
    const before = await contents(directory)
    await new Promise<void>((resolve, reject) =>
      flock(file.fd, "ex", (error) =>
        error === null ? resolve() : reject(error),
      ),
    )
    try {
      await expect(
        createChatGPTCredentialStore(input).resolve(credentials),
      ).rejects.toMatchObject({ code: "lock_timeout" })
      expect(await contents(directory)).toBe(before)
    } finally {
      await new Promise<void>((resolve, reject) =>
        flock(file.fd, "un", (error) =>
          error === null ? resolve() : reject(error),
        ),
      )
      await file.close()
    }
  })

  it.each([
    false,
    true,
  ])("does not confirm remote revocation during an uncaptured rotation (other owner: %s)", async (otherOwner) => {
    const entered = deferred()
    const release = deferred()
    const revoke = vi.fn(async () => {})
    const { input, store } = await fixture({
      revoke,
      refresh: async () => {
        entered.resolve()
        await release.promise
        return replacement
      },
    })
    await store.save(credentials)
    const pending = store
      .resolve(credentials, { forceRefresh: true })
      .catch((error) => error)
    await entered.promise
    const signingOutOwner = otherOwner
      ? createChatGPTCredentialStore(input)
      : store
    expect(await signingOutOwner.signOut(credentials)).toEqual({
      revocation: "failed",
    })
    expect(revoke).toHaveBeenCalledTimes(1)
    release.resolve()
    expect(await pending).toBeInstanceOf(Error)
    await expect(
      createChatGPTCredentialStore(input).resolve(credentials),
    ).rejects.toThrow("signed_out")
  })

  it("finishes local signout even when remote revocation fails", async () => {
    const { store } = await fixture({
      revoke: async () => {
        throw new Error(credentials.refreshToken)
      },
    })
    await store.save(credentials)
    expect(await store.signOut(credentials)).toEqual({ revocation: "failed" })
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "signed_out",
    })
    expect(await store.registration(credentials)).toMatchObject({
      clientId: credentials.clientId,
      subject: credentials.subject,
    })
  })

  it("rejects unsafe permissions and malformed storage without echoing secret input", async () => {
    const { directory, store } = await fixture()
    await store.save(credentials)
    const path = join(directory, "credentials.json")
    await chmod(path, 0o644)
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "invalid_store",
    })
    await chmod(path, 0o600)
    await writeFile(path, `{"accessToken":"${credentials.accessToken}",BROKEN`)
    const error = await store
      .resolve(credentials)
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: "invalid_store" })
    expect(String(error)).not.toContain(credentials.accessToken)
  })
  it("stores identity-only registrations without accepting tokens for plan inference", async () => {
    const { directory, store } = await fixture()
    await store.save(credentials)
    const active = await store.resolve(credentials)
    await store.saveRegistration({
      clientId: credentials.clientId,
      subject: credentials.subject,
      email: "a@example.invalid",
      idToken: credentials.idToken,
    })
    expect(active.signal.aborted).toBe(true)
    expect(await store.registration(credentials)).toEqual({
      clientId: credentials.clientId,
      subject: credentials.subject,
      email: credentials.email,
    })
    expect(await store.summaries()).toEqual([
      {
        clientId: credentials.clientId,
        subject: credentials.subject,
        email: credentials.email,
        signedIn: false,
      },
    ])
    expect(await contents(directory)).not.toContain(credentials.idToken)
    expect(await contents(directory)).not.toContain(credentials.refreshToken)
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "signed_out",
    })
  })

  it("clears a terminally rejected refresh and aborts requests while retaining registration", async () => {
    const { directory, store } = await fixture({
      refresh: async () => {
        throw new ChatGPTRefreshRevokedError()
      },
    })
    await store.save(credentials)
    const active = await store.resolve(credentials)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "reauth_required" })
    expect(active.signal.aborted).toBe(true)
    expect(await contents(directory)).not.toContain(credentials.refreshToken)
    expect(await store.registration(credentials)).toMatchObject({
      clientId: credentials.clientId,
      subject: credentials.subject,
    })
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "signed_out",
    })
  })

  it("does not clear a newer sign-in after terminal rejection of a stale refresh", async () => {
    const entered = deferred()
    const release = deferred()
    const { directory, store, input } = await fixture({
      refresh: async () => {
        entered.resolve()
        await release.promise
        throw new ChatGPTRefreshRevokedError()
      },
    })
    await store.save(credentials)
    const pending = store.resolve(credentials, { forceRefresh: true })
    const rejected = expect(pending).rejects.toMatchObject({
      code: "reauth_required",
    })
    await entered.promise
    await createChatGPTCredentialStore(input).save(replacement)
    release.resolve()
    await rejected
    expect(
      JSON.parse(await contents(directory)).accounts[0].credentials,
    ).toEqual(replacement)
    expect((await store.resolve(credentials)).accessToken).toBe(
      replacement.accessToken,
    )
  })

  it("observes cross-owner signout and aborts old requests on the next read", async () => {
    const { store, input } = await fixture()
    await store.save(credentials)
    const active = await store.resolve(credentials)
    const other = createChatGPTCredentialStore(input)
    await other.signOut(credentials)
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "signed_out",
    })
    expect(active.signal.aborted).toBe(true)
    await other.save(replacement)
    const resumed = await store.resolve(credentials)
    expect(resumed.accessToken).toBe(replacement.accessToken)
    expect(resumed.signal.aborted).toBe(false)
  })
  it("lets the signing-out owner observe a later verified sign-in from another owner", async () => {
    const { store, input } = await fixture()
    await store.save(credentials)
    const first = await store.resolve(credentials)
    await store.signOut(credentials)
    await createChatGPTCredentialStore(input).save(replacement)
    const next = await store.resolve(credentials)
    expect(next.accessToken).toBe(replacement.accessToken)
    expect(next.signal.aborted).toBe(false)
    expect(first.signal.aborted).toBe(true)
    expect((await store.summaries())[0]?.signedIn).toBe(true)
  })

  it("replaces the request signal when signout and reauthorization occur between reads", async () => {
    const { store, input } = await fixture()
    await store.save(credentials)
    const first = await store.resolve(credentials)
    const other = createChatGPTCredentialStore(input)
    await other.signOut(credentials)
    await other.save(replacement)
    const next = await store.resolve(credentials)
    expect(next.accessToken).toBe(replacement.accessToken)
    expect(first.signal.aborted).toBe(true)
    expect(next.signal).not.toBe(first.signal)
    expect(next.signal.aborted).toBe(false)
  })

  it("retains the active login generation and signal across token refresh", async () => {
    const { directory, store, input } = await fixture()
    await store.save(credentials)
    const first = await store.resolve(credentials)
    const before = JSON.parse(await contents(directory)).accounts[0]
    await createChatGPTCredentialStore(input).resolve(credentials, {
      forceRefresh: true,
    })
    const after = JSON.parse(await contents(directory)).accounts[0]
    const next = await store.resolve(credentials)
    expect(after.generation).toBe(before.generation)
    expect(after.revision).not.toBe(before.revision)
    expect(next.accessToken).toBe(replacement.accessToken)
    expect(next.signal).toBe(first.signal)
    expect(first.signal.aborted).toBe(false)
  })

  it("fails closed immediately when durable clearing of a rejected refresh fails", async () => {
    const { directory, store } = await fixture({
      refresh: async () => {
        throw new ChatGPTRefreshRevokedError()
      },
    })
    await store.save(credentials)
    const first = await store.resolve(credentials)
    const before = await contents(directory)
    const failure = new Error("simulated atomic rename failure")
    const atomicRename = promises.rename
    const rename = vi
      .spyOn(promises, "rename")
      .mockImplementationOnce(atomicRename)
      .mockImplementationOnce(async () => {
        expect(first.signal.aborted).toBe(true)
        throw failure
      })
    syncBuiltinESMExports()
    try {
      await expect(
        store.resolve(credentials, { forceRefresh: true }),
      ).rejects.toBe(failure)
    } finally {
      rename.mockRestore()
      syncBuiltinESMExports()
    }
    expect(first.signal.aborted).toBe(true)
    const after = JSON.parse(await contents(directory)).accounts[0]
    expect(after.credentials).toEqual(
      JSON.parse(before).accounts[0].credentials,
    )
    expect(after.refreshOutcomeUnknown).toBe(true)
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "signed_out",
    })
    expect((await store.summaries())[0]?.signedIn).toBe(false)
    expect(await store.registration(credentials)).not.toHaveProperty("idToken")
    await store.save(replacement)
    expect((await store.resolve(credentials)).signal.aborted).toBe(false)
  })

  it("does not abort a newer login while an older login's terminal refresh finishes", async () => {
    const entered = deferred()
    const release = deferred()
    const { store, input } = await fixture({
      refresh: async () => {
        entered.resolve()
        await release.promise
        throw new ChatGPTRefreshRevokedError()
      },
    })
    await store.save(credentials)
    const old = await store.resolve(credentials)
    const pending = store.resolve(credentials, { forceRefresh: true })
    const rejected = expect(pending).rejects.toMatchObject({
      code: "reauth_required",
    })
    await entered.promise
    await createChatGPTCredentialStore(input).save(replacement)
    const current = await store.resolve(credentials)
    expect(old.signal.aborted).toBe(true)
    release.resolve()
    await rejected
    expect(current.signal.aborted).toBe(false)
    expect((await store.resolve(credentials)).signal).toBe(current.signal)
  })
  it("keeps the local signout barrier while the durable clear is pending", async () => {
    const { store } = await fixture()
    await store.save(credentials)
    const access = await store.resolve(credentials)
    const entered = deferred()
    const release = deferred()
    const atomicRename = promises.rename
    const rename = vi
      .spyOn(promises, "rename")
      .mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        return atomicRename(...args)
      })
    syncBuiltinESMExports()
    const signingOut = store.signOut(credentials)
    try {
      expect(access.signal.aborted).toBe(true)
      await entered.promise
      const attempted = store.resolve(credentials).then(
        () => "used",
        (error: unknown) => (error as { code: string }).code,
      )
      expect(
        await Promise.race([
          attempted,
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("waited for disk"), 50),
          ),
        ]),
      ).toBe("signed_out")
    } finally {
      release.resolve()
      await signingOut
      rename.mockRestore()
      syncBuiltinESMExports()
    }
  })
  it("durably retains an inactive rotation across verification failures and restart", async () => {
    let failures = 2
    let directory = ""
    const verifyRefresh = vi.fn(
      async (previous: ChatGPTCredentials, pending: ChatGPTPendingRenewal) => {
        const persisted = JSON.parse(await contents(directory)).accounts[0]
        expect(persisted.pending.refreshToken).toBe(replacement.refreshToken)
        expect(persisted.credentials).toEqual(credentials)
        expect(previous).toEqual(credentials)
        if (failures-- > 0)
          throw new Error(`temporary JWKS failure ${pending.refreshToken}`)
        return {
          ...previous,
          ...pending,
          idToken: pending.idToken ?? previous.idToken,
        }
      },
    )
    const fixtureResult = await fixture({ verifyRefresh })
    directory = fixtureResult.directory
    const { store, input } = fixtureResult
    await store.save(credentials)
    const firstError = await store
      .resolve(credentials, { forceRefresh: true })
      .catch((error: unknown) => error)
    expect(firstError).toMatchObject({ code: "refresh_failed" })
    expect(String(firstError)).not.toContain(replacement.refreshToken)
    // Still-valid old access must not bypass verification of the pending rotation.
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "refresh_failed",
    })
    expect(await store.registration(credentials)).toMatchObject({
      idToken: credentials.idToken,
    })
    for (const token of [
      replacement.accessToken,
      replacement.refreshToken,
      replacement.idToken,
    ])
      expect(JSON.stringify(await store.summaries())).not.toContain(token)
    const restarted = createChatGPTCredentialStore(input)
    const access = await restarted.resolve(credentials)
    expect(access.accessToken).toBe(replacement.accessToken)
    expect(input.refresh).toHaveBeenCalledTimes(1)
    expect(verifyRefresh).toHaveBeenCalledTimes(3)
    const persisted = JSON.parse(await contents(directory)).accounts[0]
    expect(persisted.credentials).toEqual(replacement)
    expect(persisted).not.toHaveProperty("pending")
  })

  it("does not activate pending tokens over a newer sign-in", async () => {
    const entered = deferred()
    const release = deferred()
    const { directory, store, input } = await fixture({
      verifyRefresh: async (previous, pending) => {
        entered.resolve()
        await release.promise
        return {
          ...previous,
          ...pending,
          idToken: pending.idToken ?? previous.idToken,
        }
      },
    })
    await store.save(credentials)
    const resolving = store.resolve(credentials, { forceRefresh: true })
    const rejected = expect(resolving).rejects.toMatchObject({
      code: "credentials_changed",
    })
    await entered.promise
    expect(
      JSON.parse(await contents(directory)).accounts[0].pending.refreshToken,
    ).toBe(replacement.refreshToken)
    const latest = {
      ...replacement,
      accessToken: "fake-new-login-access",
      refreshToken: "fake-new-login-refresh",
    }
    await createChatGPTCredentialStore(input).save(latest)
    release.resolve()
    await rejected
    const persisted = JSON.parse(await contents(directory)).accounts[0]
    expect(persisted.credentials).toEqual(latest)
    expect(persisted).not.toHaveProperty("pending")
  })

  it("signout revokes the newest pending refresh token and removes all pending secrets", async () => {
    const revoke = vi.fn(async (_credentials: ChatGPTCredentials) => {})
    const { directory, store } = await fixture({
      revoke,
      verifyRefresh: async () => {
        throw new Error("temporary JWKS outage")
      },
    })
    await store.save(credentials)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "refresh_failed" })
    expect(await store.signOut(credentials)).toEqual({ revocation: "revoked" })
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke.mock.calls[0]?.[0]).toMatchObject({
      refreshToken: replacement.refreshToken,
      idToken: credentials.idToken,
      subject: credentials.subject,
    })
    const persisted = await contents(directory)
    for (const token of [
      credentials.accessToken,
      credentials.refreshToken,
      credentials.idToken,
      replacement.accessToken,
      replacement.refreshToken,
      replacement.idToken,
    ])
      expect(persisted).not.toContain(token)
    expect(await store.registration(credentials)).toEqual({
      clientId: credentials.clientId,
      subject: credentials.subject,
      email: credentials.email,
    })
  })

  it("signout cancels pending verification and prevents its late activation", async () => {
    const entered = deferred()
    const release = deferred()
    let signal: AbortSignal | undefined
    const { directory, store } = await fixture({
      verifyRefresh: async (previous, pending, verificationSignal) => {
        signal = verificationSignal
        entered.resolve()
        await release.promise
        return {
          ...previous,
          ...pending,
          idToken: pending.idToken ?? previous.idToken,
        }
      },
    })
    await store.save(credentials)
    const resolving = store.resolve(credentials, { forceRefresh: true })
    const rejected = expect(resolving).rejects.toMatchObject({
      code: "refresh_failed",
    })
    await entered.promise
    await store.signOut(credentials)
    expect(signal?.aborted).toBe(true)
    await rejected
    release.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const persisted = JSON.parse(await contents(directory)).accounts[0]
    expect(persisted).not.toHaveProperty("pending")
    expect(persisted).not.toHaveProperty("credentials")
  })
  it("renews long-offline pending access with its newest refresh token after restart", async () => {
    let clock = now
    const first = { ...replacement, expiresAt: now + 100 }
    const newest = {
      ...replacement,
      accessToken: "fake-after-offline-access",
      refreshToken: "fake-after-offline-refresh",
      expiresAt: now + 60_000,
    }
    const refresh = vi
      .fn<Parameters<typeof createChatGPTCredentialStore>[0]["refresh"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(newest)
    const verifyRefresh = vi
      .fn<Parameters<typeof createChatGPTCredentialStore>[0]["verifyRefresh"]>()
      .mockRejectedValueOnce(new Error("temporary JWKS outage"))
      .mockImplementation(async (previous, pending) => ({
        ...previous,
        ...pending,
        idToken: pending.idToken ?? previous.idToken,
      }))
    const { directory, store, input } = await fixture({
      now: () => clock,
      refresh,
      verifyRefresh,
    })
    await store.save(credentials)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "refresh_failed" })
    clock += 1_000
    const access =
      await createChatGPTCredentialStore(input).resolve(credentials)
    expect(access.accessToken).toBe(newest.accessToken)
    expect(
      refresh.mock.calls.map(([previous]) => previous.refreshToken),
    ).toEqual([credentials.refreshToken, first.refreshToken])
    expect(verifyRefresh.mock.calls[1]?.[0].idToken).toBe(credentials.idToken)
    expect(verifyRefresh.mock.calls[1]?.[1].accessToken).toBe(
      newest.accessToken,
    )
    const account = JSON.parse(await contents(directory)).accounts[0]
    expect(account.credentials.refreshToken).toBe(newest.refreshToken)
    expect(account).not.toHaveProperty("pending")
    expect(account).not.toHaveProperty("pendingNeedsRenewal")
  })

  it("persists verified ID-token expiry and renews once per subsequent resolve", async () => {
    const newest = {
      ...replacement,
      accessToken: "fake-next-access",
      refreshToken: "fake-next-refresh",
    }
    const refresh = vi
      .fn<Parameters<typeof createChatGPTCredentialStore>[0]["refresh"]>()
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(newest)
    const verifyRefresh = vi
      .fn<Parameters<typeof createChatGPTCredentialStore>[0]["verifyRefresh"]>()
      .mockRejectedValue(new ChatGPTPendingRenewalExpiredError())
    const { directory, store, input } = await fixture({
      refresh,
      verifyRefresh,
    })
    await store.save(credentials)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "pending_expired" })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(verifyRefresh).toHaveBeenCalledTimes(1)
    const pending = JSON.parse(await contents(directory)).accounts[0]
    expect(pending.pendingNeedsRenewal).toBe(true)
    expect(pending.pending.expiresAt).toBeGreaterThan(now)
    expect(pending.credentials).toEqual(credentials)
    const restarted = createChatGPTCredentialStore(input)
    await expect(restarted.resolve(credentials)).rejects.toMatchObject({
      code: "pending_expired",
    })
    expect(
      refresh.mock.calls.map(([previous]) => previous.refreshToken),
    ).toEqual([credentials.refreshToken, replacement.refreshToken])
    expect(verifyRefresh).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse(await contents(directory)).accounts[0].pending.refreshToken,
    ).toBe(newest.refreshToken)
    await restarted.signOut(credentials)
    const cleared = JSON.parse(await contents(directory)).accounts[0]
    expect(cleared).not.toHaveProperty("pending")
    expect(cleared).not.toHaveProperty("pendingNeedsRenewal")
  })

  it("never marks a newer sign-in for renewal after an old pending identity expires", async () => {
    const entered = deferred()
    const release = deferred()
    const { directory, store, input } = await fixture({
      verifyRefresh: async () => {
        entered.resolve()
        await release.promise
        throw new ChatGPTPendingRenewalExpiredError()
      },
    })
    await store.save(credentials)
    const resolving = store.resolve(credentials, { forceRefresh: true })
    const rejected = expect(resolving).rejects.toMatchObject({
      code: "pending_expired",
    })
    await entered.promise
    const fresh = { ...replacement, refreshToken: "fake-fresh-signin-refresh" }
    await createChatGPTCredentialStore(input).save(fresh)
    release.resolve()
    await rejected
    const account = JSON.parse(await contents(directory)).accounts[0]
    expect(account.credentials).toEqual(fresh)
    expect(account).not.toHaveProperty("pending")
    expect(account).not.toHaveProperty("pendingNeedsRenewal")
    expect((await store.resolve(credentials)).accessToken).toBe(
      fresh.accessToken,
    )
  })

  it.each([
    true,
    "yes",
  ])("rejects an orphaned or malformed pending-renewal flag %s", async (flag) => {
    const { directory, store } = await fixture()
    await store.save(credentials)
    const doc = JSON.parse(await contents(directory))
    doc.accounts[0].pendingNeedsRenewal = flag
    await writeFile(join(directory, "credentials.json"), JSON.stringify(doc))
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "invalid_store",
    })
  })
  it.each([
    "wrong_identity",
    "expired_identity",
  ])("retains the identity obligation across no-ID rotations and restart after %s", async (failure) => {
    let clock = now
    const first = {
      ...replacement,
      idToken: "fake-wrong-identity-id",
      expiresAt: now + 100,
    }
    const withoutId: ChatGPTPendingRenewal = {
      accessToken: "fake-no-id-access",
      refreshToken: "fake-no-id-refresh",
      scopes: replacement.scopes,
      expiresAt: now + 60_000,
    }
    const matching = {
      ...replacement,
      accessToken: "fake-matching-access",
      refreshToken: "fake-matching-refresh",
      idToken: "fake-matching-id",
    }
    const refresh = vi
      .fn<Parameters<typeof createChatGPTCredentialStore>[0]["refresh"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(withoutId)
      .mockResolvedValueOnce(matching)
    const verifyRefresh = vi.fn(
      async (previous: ChatGPTCredentials, pending: ChatGPTPendingRenewal) => {
        if (pending.idToken === first.idToken) {
          if (failure === "expired_identity")
            throw new ChatGPTPendingRenewalExpiredError()
          throw new Error("fake ID token failed subject validation")
        }
        expect(pending.idToken).toBe(matching.idToken)
        return {
          ...previous,
          ...pending,
          idToken: pending.idToken ?? previous.idToken,
        }
      },
    )
    const { directory, store, input } = await fixture({
      now: () => clock,
      refresh,
      verifyRefresh,
    })
    await store.save(credentials)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({
      code:
        failure === "expired_identity" ? "pending_expired" : "refresh_failed",
    })
    expect(
      JSON.parse(await contents(directory)).accounts[0].pendingIdentityRequired,
    ).toBe(true)
    clock += 1_000
    await expect(
      createChatGPTCredentialStore(input).resolve(credentials),
    ).rejects.toMatchObject({ code: "identity_verification_required" })
    expect(verifyRefresh).toHaveBeenCalledTimes(1)
    const inactive = JSON.parse(await contents(directory)).accounts[0]
    expect(inactive.pending).toEqual(withoutId)
    expect(inactive.pendingIdentityRequired).toBe(true)
    expect(inactive.pendingNeedsRenewal).toBe(true)
    expect(inactive.credentials).toEqual(credentials)
    const access =
      await createChatGPTCredentialStore(input).resolve(credentials)
    expect(access.accessToken).toBe(matching.accessToken)
    expect(verifyRefresh).toHaveBeenCalledTimes(2)
    expect(
      refresh.mock.calls.map(([previous]) => previous.refreshToken),
    ).toEqual([
      credentials.refreshToken,
      first.refreshToken,
      withoutId.refreshToken,
    ])
    const activated = JSON.parse(await contents(directory)).accounts[0]
    expect(activated.credentials.idToken).toBe(matching.idToken)
    expect(activated).not.toHaveProperty("pending")
    expect(activated).not.toHaveProperty("pendingIdentityRequired")
    expect(activated).not.toHaveProperty("pendingNeedsRenewal")
  })

  it("rejects verification that substitutes an older ID token for the supplied pending token", async () => {
    const { directory, store } = await fixture({
      verifyRefresh: async (previous, pending) => ({
        ...previous,
        ...pending,
        idToken: previous.idToken,
      }),
    })
    await store.save(credentials)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "invalid_credentials" })
    const account = JSON.parse(await contents(directory)).accounts[0]
    expect(account.credentials).toEqual(credentials)
    expect(account.pending.idToken).toBe(replacement.idToken)
    expect(account.pendingIdentityRequired).toBe(true)
    await store.signOut(credentials)
    expect(
      JSON.parse(await contents(directory)).accounts[0],
    ).not.toHaveProperty("pendingIdentityRequired")
  })

  it.each([
    true,
    "yes",
  ])("rejects an orphaned or malformed pending-identity flag %s", async (flag) => {
    const { directory, store } = await fixture()
    await store.save(credentials)
    const doc = JSON.parse(await contents(directory))
    doc.accounts[0].pendingIdentityRequired = flag
    await writeFile(join(directory, "credentials.json"), JSON.stringify(doc))
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "invalid_store",
    })
  })
  it("reports durable refresh uncertainty after a timeout, restart, and successful predecessor revocation", async () => {
    const release = deferred()
    const revoke = vi.fn(async (_previous: ChatGPTCredentials) => {})
    const { directory, store, input } = await fixture({
      callbackTimeoutMs: 20,
      revoke,
      refresh: async () => {
        await release.promise
        return replacement
      },
    })
    await store.save(credentials)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "refresh_failed" })
    expect(
      JSON.parse(await contents(directory)).accounts[0].refreshOutcomeUnknown,
    ).toBe(true)
    const restarted = createChatGPTCredentialStore(input)
    expect(await restarted.signOut(credentials)).toEqual({
      revocation: "failed",
    })
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke.mock.calls[0]?.[0].refreshToken).toBe(
      credentials.refreshToken,
    )
    release.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const cleared = JSON.parse(await contents(directory)).accounts[0]
    expect(cleared).not.toHaveProperty("credentials")
    expect(cleared).not.toHaveProperty("refreshOutcomeUnknown")
  })

  it("clears uncertainty only after capturing a later replacement, without blocking valid old access", async () => {
    let directory = ""
    let fail = true
    const refresh = vi.fn(async () => {
      expect(
        JSON.parse(await contents(directory)).accounts[0].refreshOutcomeUnknown,
      ).toBe(true)
      if (fail) {
        fail = false
        throw new Error("temporary exchange outage")
      }
      return replacement
    })
    const revoke = vi.fn(async (_previous: ChatGPTCredentials) => {})
    const verifyRefresh = vi.fn(async () => {
      const pending = JSON.parse(await contents(directory)).accounts[0]
      expect(pending.pending.refreshToken).toBe(replacement.refreshToken)
      expect(pending).not.toHaveProperty("refreshOutcomeUnknown")
      throw new Error("temporary JWKS outage")
    })
    const setup = await fixture({ refresh, revoke, verifyRefresh })
    directory = setup.directory
    const { store, input } = setup
    await store.save(credentials)
    const current = await store.resolve(credentials)
    await expect(
      store.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "refresh_failed" })
    expect((await store.resolve(credentials)).accessToken).toBe(
      credentials.accessToken,
    )
    expect(current.signal.aborted).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    const restarted = createChatGPTCredentialStore(input)
    await expect(
      restarted.resolve(credentials, { forceRefresh: true }),
    ).rejects.toMatchObject({ code: "refresh_failed" })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(await restarted.signOut(credentials)).toEqual({
      revocation: "revoked",
    })
    expect(revoke.mock.calls[0]?.[0].refreshToken).toBe(
      replacement.refreshToken,
    )
  })

  it.each([
    true,
    "yes",
  ])("rejects an orphaned or malformed unknown-refresh marker %s", async (flag) => {
    const { directory, store } = await fixture()
    await store.save(credentials)
    const doc = JSON.parse(await contents(directory))
    doc.accounts[0].refreshOutcomeUnknown = flag
    if (flag === true) delete doc.accounts[0].credentials
    await writeFile(join(directory, "credentials.json"), JSON.stringify(doc))
    await expect(store.resolve(credentials)).rejects.toMatchObject({
      code: "invalid_store",
    })
  })
})
