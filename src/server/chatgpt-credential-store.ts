import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { flock } from "fs-ext"
import type {
  ChatGPTCredentials,
  ChatGPTRegistration,
} from "./chatgpt-oauth.ts"

export type ChatGPTPendingRenewal = Readonly<{
  accessToken: string
  refreshToken: string
  idToken?: string
  scopes: readonly string[]
  expiresAt: number
}>
export type ChatGPTAccountIdentity = Readonly<{
  clientId: string
  subject: string
}>
export type ChatGPTAccountSummary = Readonly<{
  clientId: string
  subject: string
  email?: string
  signedIn: boolean
  expiresAt?: number
}>
type Account = ChatGPTAccountIdentity & {
  email?: string
  revision: string
  // A verified sign-in changes generation; token rotation changes only revision.
  generation: string
  credentials?: ChatGPTCredentials
  pending?: ChatGPTPendingRenewal
  pendingNeedsRenewal?: true
  pendingIdentityRequired?: true
  refreshOutcomeUnknown?: true
}
type Document = { version: 1; hostId: string; accounts: Account[] }
type Callback<T> = (
  credentials: ChatGPTCredentials,
  signal: AbortSignal,
) => Promise<T>
const HOST_ID =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// A verified expiry requires another rotation, not reuse of the consumed token.
export class ChatGPTPendingRenewalExpiredError extends Error {
  readonly code = "pending_expired"
  constructor() {
    super("ChatGPT pending credentials need renewal.")
    this.name = "ChatGPTPendingRenewalExpiredError"
  }
}
// The protocol owner uses this only for terminal refresh rejection, never outages.
export class ChatGPTRefreshRevokedError extends Error {
  readonly code = "reauth_required"
  constructor() {
    super("ChatGPT credentials require sign-in.")
    this.name = "ChatGPTRefreshRevokedError"
  }
}
export class ChatGPTCredentialStoreError extends Error {
  readonly code:
    | "invalid_store"
    | "invalid_credentials"
    | "identity_verification_required"
    | "signed_out"
    | "credentials_changed"
    | "refresh_failed"
    | "lock_timeout"
  constructor(code: ChatGPTCredentialStoreError["code"]) {
    super(`ChatGPT credentials unavailable (${code}).`)
    this.name = "ChatGPTCredentialStoreError"
    this.code = code
  }
}

// Server-only, intentionally not wired to RPC/UI. Call hostId() before beginning
// sign-in; save accepts verified sign-ins. Refresh rotation is persisted before
// verifyRefresh performs fallible identity checks. Never share this directory with CLI auth.
// Request signals stop this owner immediately on signout; another process learns
// of signout on its next resolve, not through a cross-process abort signal.
export function createChatGPTCredentialStore(input: {
  directory: string
  refresh: Callback<ChatGPTPendingRenewal>
  verifyRefresh: (
    previous: ChatGPTCredentials,
    pending: ChatGPTPendingRenewal,
    signal: AbortSignal,
  ) => Promise<ChatGPTCredentials>
  revoke?: Callback<void>
  now?: () => number
  lockTimeoutMs?: number
  callbackTimeoutMs?: number
}) {
  const path = join(input.directory, "credentials.json")
  const now = input.now ?? Date.now
  // Local safety bounds, not service limits: stalled owners cannot block forever.
  const lockTimeout = input.lockTimeoutMs ?? 30_000
  const callbackTimeout = input.callbackTimeoutMs ?? 15_000
  if (![lockTimeout, callbackTimeout].every((n) => Number.isFinite(n) && n > 0))
    throw new Error(
      "ChatGPT credential timeouts must be positive finite numbers.",
    )
  // null blocks all generations until a local clear is durable. Otherwise only
  // the rejected login generation is blocked, allowing a later verified sign-in.
  const blocked = new Map<string, string | null>()
  const epochs = new Map<string, number>()
  const active = new Map<
    string,
    Set<{ generation: string; controller: AbortController }>
  >()
  const sessions = new Map<
    string,
    { generation: string; controller: AbortController }
  >()
  const key = (identity: ChatGPTAccountIdentity) =>
    JSON.stringify([identity.clientId, identity.subject])
  const find = (doc: Document, identity: ChatGPTAccountIdentity) =>
    doc.accounts.find((a) => key(a) === key(identity))

  function isBlocked(accountKey: string, generation?: string) {
    return (
      blocked.has(accountKey) &&
      (blocked.get(accountKey) === null ||
        blocked.get(accountKey) === generation)
    )
  }
  function reconcile(doc: Document) {
    for (const [accountKey, session] of sessions) {
      const account = doc.accounts.find((a) => key(a) === accountKey)
      if (!account?.credentials || account.generation !== session.generation) {
        session.controller.abort()
        sessions.delete(accountKey)
      }
    }
    for (const account of doc.accounts) {
      const accountKey = key(account)
      if (
        account.credentials &&
        blocked.has(accountKey) &&
        blocked.get(accountKey) !== null &&
        blocked.get(accountKey) !== account.generation
      )
        blocked.delete(accountKey)
    }
  }
  function resolved(
    identity: ChatGPTAccountIdentity,
    accessToken: string,
    generation: string,
  ) {
    const accountKey = key(identity)
    const previous = sessions.get(accountKey)
    if (previous && previous.generation !== generation)
      previous.controller.abort()
    const controller =
      previous?.generation === generation && !previous.controller.signal.aborted
        ? previous.controller
        : new AbortController()
    sessions.set(accountKey, { generation, controller })
    return {
      clientId: identity.clientId,
      subject: identity.subject,
      accessToken,
      signal: controller.signal,
    }
  }
  async function prepare() {
    await mkdir(input.directory, { recursive: true, mode: 0o700 })
    const directory = await open(
      input.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const stat = await directory.stat()
      if (process.getuid && stat.uid !== process.getuid())
        throw new ChatGPTCredentialStoreError("invalid_store")
      await directory.chmod(0o700)
    } finally {
      await directory.close()
    }
  }
  async function openLock(name: string) {
    await prepare()
    const file = await open(
      join(input.directory, `${name}.lock`),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))
        throw new ChatGPTCredentialStoreError("invalid_store")
      await file.chmod(0o600)
      return file
    } catch (error) {
      await file.close()
      throw error
    }
  }
  async function lock<T>(name: string, run: () => Promise<T>): Promise<T> {
    const file = await openLock(name)
    try {
      const deadline = Date.now() + lockTimeout
      for (;;) {
        try {
          await flockAsync(file.fd, "exnb")
          break
        } catch (error) {
          if (!hasCode(error, "EAGAIN") && !hasCode(error, "EWOULDBLOCK"))
            throw error
          if (Date.now() >= deadline)
            throw new ChatGPTCredentialStoreError("lock_timeout")
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      try {
        return await run()
      } finally {
        await flockAsync(file.fd, "un")
      }
    } finally {
      await file.close()
    }
  }
  async function excludeRefresh(
    accountKey: string,
  ): Promise<(() => Promise<void>) | undefined> {
    const file = await openLock(
      `refresh-${createHash("sha256").update(accountKey).digest("hex")}`,
    )
    try {
      await flockAsync(file.fd, "exnb")
    } catch (error) {
      await file.close()
      if (hasCode(error, "EAGAIN") || hasCode(error, "EWOULDBLOCK"))
        return undefined
      throw error
    }
    return async () => {
      try {
        await flockAsync(file.fd, "un")
      } finally {
        await file.close()
      }
    }
  }
  async function read(): Promise<Document | undefined> {
    let file: FileHandle
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined
      throw error
    }
    try {
      const stat = await file.stat()
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new ChatGPTCredentialStoreError("invalid_store")
      let value: unknown
      try {
        value = JSON.parse(await file.readFile("utf8"))
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new ChatGPTCredentialStoreError("invalid_store")
        throw error
      }
      if (
        !record(value) ||
        value.version !== 1 ||
        typeof value.hostId !== "string" ||
        !HOST_ID.test(value.hostId) ||
        !Array.isArray(value.accounts)
      )
        throw new ChatGPTCredentialStoreError("invalid_store")
      const accounts: Account[] = value.accounts.map((a: unknown) => {
        if (
          !record(a) ||
          !identityValid(a) ||
          !text(a.revision) ||
          !text(a.generation) ||
          (a.email !== undefined && !text(a.email))
        )
          throw new ChatGPTCredentialStoreError("invalid_store")
        const credentials =
          a.credentials === undefined ? undefined : validated(a.credentials)
        const pending =
          a.pending === undefined ? undefined : validatedRenewal(a.pending)
        if (
          (pending && !credentials) ||
          (a.pendingNeedsRenewal !== undefined &&
            (a.pendingNeedsRenewal !== true || !pending)) ||
          (a.pendingIdentityRequired !== undefined &&
            (a.pendingIdentityRequired !== true || !pending)) ||
          (a.refreshOutcomeUnknown !== undefined &&
            (a.refreshOutcomeUnknown !== true || !credentials))
        )
          throw new ChatGPTCredentialStoreError("invalid_store")
        if (credentials && key(credentials) !== key(a))
          throw new ChatGPTCredentialStoreError("invalid_store")
        return {
          clientId: a.clientId,
          subject: a.subject,
          revision: a.revision,
          generation: a.generation,
          ...(a.email === undefined ? {} : { email: a.email as string }),
          ...(credentials ? { credentials } : {}),
          ...(pending ? { pending } : {}),
          ...(a.pendingNeedsRenewal === true
            ? { pendingNeedsRenewal: true as const }
            : {}),
          ...(a.pendingIdentityRequired === true ||
          pending?.idToken !== undefined
            ? { pendingIdentityRequired: true as const }
            : {}),
          ...(a.refreshOutcomeUnknown === true
            ? { refreshOutcomeUnknown: true as const }
            : {}),
        }
      })
      if (new Set(accounts.map(key)).size !== accounts.length)
        throw new ChatGPTCredentialStoreError("invalid_store")
      return { version: 1, hostId: value.hostId, accounts }
    } finally {
      await file.close()
    }
  }
  async function write(doc: Document) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.writeFile(JSON.stringify(doc))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
      const directory = await open(
        input.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
  async function document<T>(run: (doc: Document) => Promise<T>): Promise<T> {
    return lock("store", async () => {
      let doc = await read()
      if (!doc) {
        doc = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] }
        await write(doc)
      }
      reconcile(doc)
      return run(doc)
    })
  }
  function assertActive(
    accountKey: string,
    epoch: number,
    generation?: string,
  ) {
    if (
      isBlocked(accountKey, generation) ||
      (epochs.get(accountKey) ?? 0) !== epoch
    )
      throw new ChatGPTCredentialStoreError("signed_out")
  }
  async function callback<T>(
    accountKey: string,
    credentials: ChatGPTCredentials,
    fn: Callback<T>,
    generation: string,
  ): Promise<T> {
    const controller = new AbortController()
    const controllers =
      active.get(accountKey) ??
      new Set<{ generation: string; controller: AbortController }>()
    const entry = { generation, controller }
    active.set(accountKey, controllers)
    controllers.add(entry)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          fn(structuredClone(credentials), controller.signal),
        ),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new ChatGPTCredentialStoreError("refresh_failed")),
            { once: true },
          )
          timer = setTimeout(() => controller.abort(), callbackTimeout)
        }),
      ])
    } catch (error) {
      if (
        error instanceof ChatGPTRefreshRevokedError ||
        error instanceof ChatGPTPendingRenewalExpiredError
      )
        throw error
      // Callback/network errors may quote secrets. No raw cause crosses this boundary.
      throw new ChatGPTCredentialStoreError("refresh_failed")
    } finally {
      clearTimeout(timer)
      controllers.delete(entry)
      if (controllers.size === 0) active.delete(accountKey)
    }
  }
  function stop(accountKey: string, generation?: string) {
    const session = sessions.get(accountKey)
    if (generation === undefined || session?.generation === generation)
      session?.controller.abort()
    if (generation === undefined) {
      blocked.set(accountKey, null)
      epochs.set(accountKey, (epochs.get(accountKey) ?? 0) + 1)
    } else if (blocked.get(accountKey) !== null)
      blocked.set(accountKey, generation)
    for (const entry of active.get(accountKey) ?? [])
      if (generation === undefined || entry.generation === generation)
        entry.controller.abort()
  }
  async function persistAccount(
    registration: ChatGPTRegistration,
    credentials?: ChatGPTCredentials,
  ): Promise<void> {
    if (
      !identityValid(registration) ||
      (registration.email !== undefined && !text(registration.email))
    )
      throw new ChatGPTCredentialStoreError("invalid_credentials")
    const accountKey = key(registration)
    if (!credentials) stop(accountKey)
    const epoch = epochs.get(accountKey) ?? 0
    const next: Account = {
      clientId: registration.clientId,
      subject: registration.subject,
      ...(registration.email === undefined
        ? {}
        : { email: registration.email }),
      revision: randomUUID(),
      generation: randomUUID(),
      ...(credentials ? { credentials } : {}),
    }
    await document(async (doc) => {
      if ((epochs.get(accountKey) ?? 0) !== epoch)
        throw new ChatGPTCredentialStoreError("signed_out")
      doc.accounts = [
        ...doc.accounts.filter((a) => key(a) !== accountKey),
        next,
      ]
      await write(doc)
      if ((epochs.get(accountKey) ?? 0) !== epoch)
        throw new ChatGPTCredentialStoreError("signed_out")
      sessions.get(accountKey)?.controller.abort()
      sessions.delete(accountKey)
      if (credentials) blocked.delete(accountKey)
      else blocked.set(accountKey, next.generation)
    })
  }
  async function clear(doc: Document, account: Account) {
    const previous = account.credentials && {
      ...account.credentials,
      refreshToken:
        account.pending?.refreshToken ?? account.credentials.refreshToken,
    }
    delete account.credentials
    delete account.pending
    delete account.pendingNeedsRenewal
    delete account.pendingIdentityRequired
    delete account.refreshOutcomeUnknown
    account.revision = randomUUID()
    await write(doc)
    return previous
  }
  return {
    hostId: () => document(async (doc) => doc.hostId),
    summaries: (): Promise<ChatGPTAccountSummary[]> =>
      document(async (doc) =>
        doc.accounts.map((a) => ({
          clientId: a.clientId,
          subject: a.subject,
          ...(a.email === undefined ? {} : { email: a.email }),
          signedIn:
            a.credentials !== undefined && !isBlocked(key(a), a.generation),
          ...(a.credentials ? { expiresAt: a.credentials.expiresAt } : {}),
        })),
      ),
    registration: (
      identity: ChatGPTAccountIdentity,
    ): Promise<ChatGPTRegistration | undefined> =>
      document(async (doc) => {
        const a = find(doc, identity)
        return a
          ? {
              clientId: a.clientId,
              subject: a.subject,
              ...(a.email === undefined ? {} : { email: a.email }),
              ...(a.credentials && !isBlocked(key(a), a.generation)
                ? { idToken: a.credentials.idToken }
                : {}),
            }
          : undefined
      }),
    saveRegistration: (registration: ChatGPTRegistration): Promise<void> =>
      persistAccount(registration),
    save: (credentials: ChatGPTCredentials): Promise<void> => {
      const verified = validated(credentials)
      return persistAccount(verified, verified)
    },
    async resolve(
      identity: ChatGPTAccountIdentity,
      options?: { forceRefresh?: boolean },
    ): Promise<
      ChatGPTAccountIdentity & { accessToken: string; signal: AbortSignal }
    > {
      const accountKey = key(identity)
      const epoch = epochs.get(accountKey) ?? 0
      assertActive(accountKey, epoch)
      const initial = await document(async (doc) => find(doc, identity))
      assertActive(accountKey, epoch, initial?.generation)
      if (!initial?.credentials) {
        sessions.get(accountKey)?.controller.abort()
        throw new ChatGPTCredentialStoreError("signed_out")
      }
      if (
        !options?.forceRefresh &&
        !initial.pending &&
        initial.credentials.expiresAt > now()
      )
        return resolved(
          identity,
          initial.credentials.accessToken,
          initial.generation,
        )
      return lock(
        `refresh-${createHash("sha256").update(accountKey).digest("hex")}`,
        async () => {
          assertActive(accountKey, epoch)
          const before = await document(async (doc) => find(doc, identity))
          assertActive(accountKey, epoch, before?.generation)
          if (!before?.credentials) {
            sessions.get(accountKey)?.controller.abort()
            throw new ChatGPTCredentialStoreError("signed_out")
          }
          // Another process already rotated our source token; never consume it twice.
          if (
            before.revision !== initial.revision &&
            !before.refreshOutcomeUnknown &&
            !before.pending &&
            before.credentials.expiresAt > now()
          )
            return resolved(
              identity,
              before.credentials.accessToken,
              before.generation,
            )
          const previous = before.credentials
          let revision = before.revision
          let renewal: ChatGPTPendingRenewal
          let next: ChatGPTCredentials
          let identityRequired = before.pendingIdentityRequired === true
          const mustRenew =
            !before.pending ||
            before.pending.expiresAt <= now() ||
            before.pendingNeedsRenewal === true
          try {
            if (mustRenew) {
              revision = await document(async (doc) => {
                const latest = find(doc, identity)
                assertActive(accountKey, epoch, latest?.generation)
                if (!latest?.credentials)
                  throw new ChatGPTCredentialStoreError("signed_out")
                if (latest.revision !== revision)
                  throw new ChatGPTCredentialStoreError("credentials_changed")
                // A timed-out request may finish remotely after its local lock ends.
                // Persist uncertainty before sending, not only while a callback lives.
                latest.refreshOutcomeUnknown = true
                latest.revision = randomUUID()
                await write(doc)
                assertActive(accountKey, epoch, latest.generation)
                return latest.revision
              })
            }
            renewal =
              mustRenew || !before.pending
                ? validatedRenewal(
                    await callback(
                      accountKey,
                      {
                        ...previous,
                        refreshToken:
                          before.pending?.refreshToken ?? previous.refreshToken,
                      },
                      input.refresh,
                      before.generation,
                    ),
                  )
                : before.pending
            identityRequired ||= renewal.idToken !== undefined
            assertActive(accountKey, epoch, before.generation)
            if (mustRenew) {
              revision = await document(async (doc) => {
                const latest = find(doc, identity)
                assertActive(accountKey, epoch, latest?.generation)
                if (!latest?.credentials)
                  throw new ChatGPTCredentialStoreError("signed_out")
                if (latest.revision !== revision)
                  throw new ChatGPTCredentialStoreError("credentials_changed")
                latest.pending = renewal
                delete latest.refreshOutcomeUnknown
                // A later rotation without an ID token cannot erase an earlier
                // supplied token's still-unresolved identity verification.
                if (identityRequired) latest.pendingIdentityRequired = true
                delete latest.pendingNeedsRenewal
                latest.revision = randomUUID()
                // A successful rotation has consumed the old refresh token. Preserve
                // its replacement before fallible JWKS/identity verification begins.
                await write(doc)
                assertActive(accountKey, epoch, latest.generation)
                return latest.revision
              })
            }
            if (identityRequired && renewal.idToken === undefined)
              throw new ChatGPTCredentialStoreError(
                "identity_verification_required",
              )
            next = validated(
              await callback(
                accountKey,
                previous,
                (source, signal) =>
                  input.verifyRefresh(source, structuredClone(renewal), signal),
                before.generation,
              ),
            )
          } catch (error) {
            if (
              error instanceof ChatGPTPendingRenewalExpiredError ||
              (error instanceof ChatGPTCredentialStoreError &&
                error.code === "identity_verification_required")
            ) {
              await document(async (doc) => {
                const latest = find(doc, identity)
                assertActive(accountKey, epoch, latest?.generation)
                if (latest?.pending && latest.revision === revision) {
                  latest.pendingNeedsRenewal = true
                  latest.revision = randomUUID()
                  await write(doc)
                }
              })
              throw error // One refresh at most; the next resolve renews this token.
            }
            if (!(error instanceof ChatGPTRefreshRevokedError)) throw error
            stop(accountKey, before.generation) // Fail closed before any fallible I/O.
            await document(async (doc) => {
              const latest = find(doc, identity)
              if (latest?.credentials && latest.revision === revision)
                await clear(doc, latest)
            })
            throw error
          }
          assertActive(accountKey, epoch, before.generation)
          if (
            key(next) !== accountKey ||
            next.expiresAt <= now() ||
            next.accessToken !== renewal.accessToken ||
            next.refreshToken !== renewal.refreshToken ||
            (identityRequired && next.idToken !== renewal.idToken)
          )
            throw new ChatGPTCredentialStoreError("invalid_credentials")
          return document(async (doc) => {
            const latest = find(doc, identity)
            assertActive(accountKey, epoch, latest?.generation)
            if (!latest?.credentials) {
              sessions.get(accountKey)?.controller.abort()
              throw new ChatGPTCredentialStoreError("signed_out")
            }
            if (latest.revision !== revision)
              throw new ChatGPTCredentialStoreError("credentials_changed")
            latest.credentials = next
            delete latest.pending
            delete latest.pendingNeedsRenewal
            delete latest.pendingIdentityRequired
            latest.revision = randomUUID()
            await write(doc) // Replacement is durable before it can authorize a request.
            assertActive(accountKey, epoch, latest.generation)
            return resolved(identity, next.accessToken, latest.generation)
          })
        },
      )
    },
    async signOut(
      identity: ChatGPTAccountIdentity,
    ): Promise<{ revocation: "not_requested" | "revoked" | "failed" }> {
      const accountKey = key(identity)
      const localOperation = (active.get(accountKey)?.size ?? 0) > 0
      stop(accountKey) // Stop local requests before waiting on filesystem/network.
      const release = await excludeRefresh(accountKey)
      // Another process may have rotated after our snapshot, or an aborted local
      // refresh may have completed remotely. Revoking the predecessor is not proof
      // that this late replacement was revoked. The UI must report unconfirmed.
      const uncertain = localOperation || release === undefined
      try {
        const epoch = epochs.get(accountKey)
        const previous = await document(async (doc) => {
          const a = find(doc, identity)
          const outcomeUnknown = a?.refreshOutcomeUnknown === true
          const credentials = a ? await clear(doc, a) : undefined
          if (epochs.get(accountKey) === epoch)
            blocked.set(accountKey, a?.generation ?? "")
          return {
            credentials,
            generation: a?.generation ?? "",
            outcomeUnknown,
          }
        })
        const unconfirmed = uncertain || previous.outcomeUnknown
        if (!previous.credentials || !input.revoke)
          return { revocation: unconfirmed ? "failed" : "not_requested" }
        try {
          await callback(
            accountKey,
            previous.credentials,
            input.revoke,
            previous.generation,
          )
          return { revocation: unconfirmed ? "failed" : "revoked" }
        } catch (error) {
          if (error instanceof ChatGPTCredentialStoreError)
            return { revocation: "failed" }
          throw error
        }
      } finally {
        await release?.()
      }
    },
  }
}

function validatedRenewal(value: unknown): ChatGPTPendingRenewal {
  if (
    !record(value) ||
    !text(value.accessToken) ||
    !text(value.refreshToken) ||
    (value.idToken !== undefined && !text(value.idToken)) ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every(text) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0
  )
    throw new ChatGPTCredentialStoreError("invalid_credentials")
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    ...(value.idToken === undefined
      ? {}
      : { idToken: value.idToken as string }),
    scopes: [...value.scopes],
    expiresAt: value.expiresAt,
  }
}

function validated(value: unknown): ChatGPTCredentials {
  const scopes = record(value) ? value.scopes : undefined
  if (
    !record(value) ||
    !identityValid(value) ||
    value.issuer !== "https://auth.openai.com" ||
    !text(value.idToken) ||
    !text(value.accessToken) ||
    !text(value.refreshToken) ||
    (value.email !== undefined && !text(value.email)) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0 ||
    !Array.isArray(scopes) ||
    !scopes.every(text) ||
    !["openid", "resource.invoke", "chatgpt.tokens.use.direct"].every((s) =>
      scopes.includes(s),
    )
  )
    throw new ChatGPTCredentialStoreError("invalid_credentials")
  return {
    issuer: value.issuer,
    clientId: value.clientId,
    subject: value.subject,
    ...(value.email === undefined ? {} : { email: value.email as string }),
    idToken: value.idToken,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    scopes: [...scopes],
    expiresAt: value.expiresAt,
  }
}
function identityValid(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ChatGPTAccountIdentity {
  return (
    text(value.clientId) &&
    /^oaiapp_[A-Za-z0-9_-]+$/.test(value.clientId) &&
    text(value.subject)
  )
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code
}
function flockAsync(fd: number, operation: "exnb" | "un"): Promise<void> {
  return new Promise((resolve, reject) =>
    flock(fd, operation, (error) =>
      error === null ? resolve() : reject(error),
    ),
  )
}
