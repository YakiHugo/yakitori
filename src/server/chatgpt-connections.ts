import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { openChatGPTAuthorization } from "./chatgpt-browser.ts"
import { createChatGPTConnectionMetadata } from "./chatgpt-connection-metadata.ts"
import {
  createChatGPTCredentialStore,
  type ChatGPTAccountIdentity,
} from "./chatgpt-credential-store.ts"
import { createChatGPTLoopback } from "./chatgpt-loopback.ts"
import { ChatGPTAuthError, createChatGPTOAuth } from "./chatgpt-oauth.ts"
import { createChatGPTTokenClient } from "./chatgpt-token-client.ts"
import { ConfigurationError } from "./config-errors.ts"

export type ChatGPTConnectionState = Readonly<{
  accounts: readonly Readonly<{
    id: string
    label: string
    email?: string
    providerId: string
    state: "connected" | "identity_only" | "signed_out"
    remoteRevocation?: "confirmed" | "unconfirmed"
  }>[]
  attempt?: Readonly<{
    id: string
    accountId?: string
    state: "waiting" | "succeeded" | "cancelled" | "failed" | "identity_only"
    message?: string
  }>
  welcomeRequired: boolean
}>
export type ChatGPTConnections = ReturnType<typeof createChatGPTConnections>

// This owner joins verified OAuth, protected credentials and display metadata.
// The renderer receives only the read projection, never a URL or token.
export function createChatGPTConnections(input: {
  directory: string
  fetchFn?: typeof fetch
  openAuthorization?: (url: string, signal?: AbortSignal) => Promise<void>
  changed?: () => Promise<void> | void
  reportError?: (error: Error) => void
  attemptTimeoutMs?: number
}) {
  const tokenClient = createChatGPTTokenClient(
    input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn },
  )
  const store = createChatGPTCredentialStore({
    directory: join(input.directory, "auth"),
    ...tokenClient,
  })
  const metadata = createChatGPTConnectionMetadata(input.directory)
  const lifetime = new AbortController()
  let state: ChatGPTConnectionState["attempt"]
  let active:
    | {
        id: string
        accountId: string
        cancel(): void
        listener: Awaited<ReturnType<typeof createChatGPTLoopback>>
        timer: ReturnType<typeof setTimeout>
        commit?: Promise<void>
      }
    | undefined
  let generation = 0
  let starting: Promise<void> | undefined
  const changed = async () => {
    await input.changed?.()
  }
  async function read(): Promise<ChatGPTConnectionState> {
    const [document, summaries] = await Promise.all([
      metadata.read(),
      store.summaries(),
    ])
    const accounts = document.accounts.map((account) => {
      const summary = summaries.find(
        (a) =>
          a.clientId === account.identity?.clientId &&
          a.subject === account.identity?.subject,
      )
      return {
        id: account.id,
        label: account.label,
        providerId: providerId(account.id),
        ...(summary?.email === undefined ? {} : { email: summary.email }),
        state: summary?.signedIn
          ? ("connected" as const)
          : account.identityOnly
            ? ("identity_only" as const)
            : ("signed_out" as const),
        ...(account.remoteRevocation === undefined
          ? {}
          : { remoteRevocation: account.remoteRevocation }),
      }
    })
    return {
      accounts,
      ...(state === undefined ? {} : { attempt: state }),
      welcomeRequired:
        !document.welcomed && accounts.some((a) => a.state === "connected"),
    }
  }
  async function stopAttempt(attemptId: string, notify = true) {
    if (active?.id !== attemptId) return
    const pending = active
    // The callback owns terminal reporting even if its persistence commit fails.
    // Waiting for that outcome must not poison later cancel/close operations.
    if (pending.commit) {
      await pending.commit.catch(() => {})
      return
    }
    active = undefined
    generation++
    pending.cancel()
    clearTimeout(pending.timer)
    state = { id: pending.id, accountId: pending.accountId, state: "cancelled" }
    await pending.listener.close()
    if (notify) await changed()
  }
  async function cancel(attemptId: string) {
    await stopAttempt(attemptId)
    return read()
  }
  async function start(request: { accountId?: string; label?: string }) {
    if (lifetime.signal.aborted)
      throw new ConfigurationError("ChatGPT connections are closed.")
    if (active) await cancel(active.id)
    const version = ++generation
    const document = await metadata.read()
    const selected =
      request.accountId === undefined
        ? undefined
        : document.accounts.find((a) => a.id === request.accountId)
    if (request.accountId !== undefined && !selected)
      throw new ConfigurationError("ChatGPT connection does not exist.")
    let label = request.label?.trim()
    if (
      label !== undefined &&
      (!label || label.length > 80 || /[\r\n\0]/.test(label))
    )
      throw new ConfigurationError(
        "Use a ChatGPT connection label of 1–80 characters.",
      )
    if (
      label !== undefined &&
      document.accounts.some((a) => a.id !== selected?.id && a.label === label)
    )
      throw new ConfigurationError(
        "Choose a distinct ChatGPT connection label.",
      )
    if (!label) {
      let number = 1
      while (
        document.accounts.some(
          (a) => a.label === `ChatGPT connection ${number}`,
        )
      )
        number++
      label = selected?.label ?? `ChatGPT connection ${number}`
    }
    const account = selected ?? { id: `connection_${randomUUID()}`, label }
    if (!selected)
      await metadata.update((doc) => {
        if (doc.accounts.some((existing) => existing.label === account.label))
          throw new ConfigurationError(
            "Choose a distinct ChatGPT connection label.",
          )
        doc.accounts.push(account)
      })
    const registration =
      selected?.identity === undefined
        ? undefined
        : await store.registration(selected.identity)
    const hostId = await store.hostId()
    if (version !== generation || lifetime.signal.aborted) return
    const id = `attempt_${randomUUID()}`
    const browser = new AbortController()
    let attempt: ReturnType<ReturnType<typeof createChatGPTOAuth>["begin"]>
    const listener = await createChatGPTLoopback({
      async callback(url) {
        if (active?.id !== id) return "invalid"
        const pending = active
        try {
          let credentials:
            | import("./chatgpt-oauth.ts").ChatGPTCredentials
            | undefined
          let identityOnly:
            | import("./chatgpt-oauth.ts").ChatGPTRegistration
            | undefined
          try {
            credentials = await attempt.complete(url, async (clientId) => {
              if (active?.id !== id)
                throw new ChatGPTAuthError("expired_attempt")
              await metadata.update((doc) => {
                const record = doc.accounts.find((a) => a.id === account.id)
                if (!record) throw new Error("ChatGPT connection is missing.")
                // Recovery metadata alone cannot activate an account.
                if (!record.identity) record.pendingClientId = clientId
              })
            })
          } catch (error) {
            if (
              error instanceof ChatGPTAuthError &&
              error.code === "invalid_callback"
            )
              return "invalid"
            if (
              error instanceof ChatGPTAuthError &&
              error.code === "missing_permission" &&
              attempt.registration
            )
              identityOnly = attempt.registration
            else throw error
          }
          if (active?.id !== id) return "invalid"
          const verified = credentials ?? identityOnly
          if (!verified)
            throw new Error("Verified ChatGPT identity is missing.")
          pending.commit = metadata.update(async (doc) => {
            const record = doc.accounts.find((a) => a.id === account.id)
            if (!record) throw new Error("ChatGPT connection is missing.")
            if (credentials) {
              await store.save(credentials)
              delete record.identityOnly
              delete record.remoteRevocation
            } else {
              // A verified OAuth result with narrowed permission supersedes the
              // old plan grant. Cancellation before verification leaves it alone.
              await store.saveRegistration(verified)
              record.identityOnly = true
            }
            record.identity = {
              clientId: verified.clientId,
              subject: verified.subject,
            }
            delete record.pendingClientId
          })
          await pending.commit
          state = {
            id,
            accountId: account.id,
            state: credentials ? "succeeded" : "identity_only",
            ...(credentials
              ? {}
              : {
                  message:
                    "Signed in without ChatGPT plan permission. Continue with ChatGPT to enable plan usage.",
                }),
          }
        } catch (error) {
          if (active?.id !== id) return "invalid"
          state = {
            id,
            accountId: account.id,
            state: "failed",
            message:
              error instanceof ChatGPTAuthError &&
              error.code === "access_denied"
                ? "ChatGPT sign-in was declined."
                : "ChatGPT sign-in could not be completed. Please try again.",
          }
          if (!(error instanceof ChatGPTAuthError))
            input.reportError?.(
              new Error("ChatGPT connection could not be saved."),
            )
        } finally {
          if (active?.id === id && state?.state !== "waiting") {
            active = undefined
            clearTimeout(pending.timer)
            browser.abort()
            // Finish the fixed-text callback before closing its socket.
            void listener.close(false)
            await changed()
          }
        }
        return "accepted"
      },
    })
    if (version !== generation || lifetime.signal.aborted) {
      await listener.close()
      return
    }
    attempt = createChatGPTOAuth({
      hostId,
      ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
    }).begin(
      listener.redirectUri,
      registration,
      registration ? undefined : selected?.pendingClientId,
      { requestPlanConsent: selected?.identityOnly === true },
    )
    const timer = setTimeout(
      () => {
        void cancel(id).catch(() =>
          input.reportError?.(new Error("ChatGPT cancellation failed.")),
        )
      },
      input.attemptTimeoutMs ?? 10 * 60_000,
    )
    timer.unref()
    active = {
      id,
      accountId: account.id,
      cancel: () => {
        attempt.cancel()
        browser.abort()
      },
      listener,
      timer,
    }
    state = { id, accountId: account.id, state: "waiting" }
    await changed()
    // OS launch completion is not the sign-in RPC lifetime. Return the bound
    // attempt immediately, so Cancel/Close can always address it while a system
    // browser launcher is slow or unresponsive.
    void Promise.resolve()
      .then(async () => {
        if (browser.signal.aborted) return
        await (input.openAuthorization ?? openChatGPTAuthorization)(
          attempt.authorizationUrl,
          browser.signal,
        )
      })
      .catch(async () => {
        if (active?.id !== id) return
        await stopAttempt(id)
        if (
          state?.id !== id ||
          state.state !== "cancelled" ||
          active !== undefined
        )
          return
        state = {
          id,
          accountId: account.id,
          state: "failed",
          message:
            "The system browser could not be opened. Try signing in again.",
        }
        await changed()
      })
      .catch(() =>
        input.reportError?.(
          new Error("ChatGPT browser launch cleanup failed."),
        ),
      )
  }
  return {
    read,
    async signIn(request: { accountId?: string; label?: string }) {
      if (starting)
        throw new ConfigurationError("ChatGPT sign-in is already starting.")
      starting = start(request)
      try {
        await starting
      } finally {
        starting = undefined
      }
      return read()
    },
    cancel,
    async signOut(accountId: string) {
      if (active?.accountId === accountId) await cancel(active.id)
      const account = (await metadata.read()).accounts.find(
        (a) => a.id === accountId,
      )
      if (!account)
        throw new ConfigurationError("ChatGPT connection does not exist.")
      const outcome = account.identity
        ? await store.signOut(account.identity)
        : { revocation: "not_requested" }
      await metadata.update((doc) => {
        const record = doc.accounts.find((a) => a.id === accountId)
        if (!record) throw new Error("ChatGPT connection is missing.")
        delete record.identityOnly
        if (outcome.revocation === "failed")
          record.remoteRevocation = "unconfirmed"
        else if (outcome.revocation === "revoked")
          record.remoteRevocation = "confirmed"
      })
      await changed()
      return read()
    },
    async acknowledge() {
      await metadata.update((doc) => {
        doc.welcomed = true
      })
      return read()
    },
    async available() {
      const [document, summaries] = await Promise.all([
        metadata.read(),
        store.summaries(),
      ])
      return document.accounts.flatMap((account) =>
        account.identity &&
        summaries.some(
          (a) =>
            a.clientId === account.identity?.clientId &&
            a.subject === account.identity.subject &&
            a.signedIn,
        )
          ? [
              {
                id: providerId(account.id),
                label: account.label,
                identity: account.identity,
              },
            ]
          : [],
      )
    },
    async resolve(identity: ChatGPTAccountIdentity) {
      if (lifetime.signal.aborted)
        throw new Error("ChatGPT connections are closed.")
      const token = await store.resolve(identity)
      return {
        ...token,
        signal: AbortSignal.any([token.signal, lifetime.signal]),
      }
    },
    async close() {
      lifetime.abort()
      generation++
      if (active) await stopAttempt(active.id, false)
      await starting
    },
  }
}
function providerId(id: string) {
  return `chatgpt-${id.slice("connection_".length)}`
}
