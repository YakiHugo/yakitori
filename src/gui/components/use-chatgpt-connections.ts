import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ChatGPTConnectionState } from "../../server/chatgpt-connections.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"

export function useChatGPTConnections(apiBase: string, active: boolean) {
  const [state, setState] = useState<ChatGPTConnectionState>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [reconnectingAccountId, setReconnectingAccountId] = useState<string>()
  const [dialog, setDialog] = useState<"new" | "attempt">()
  const mounted = useRef(false)
  const visible = useRef(active)
  visible.current = active
  const busy = useRef(false)
  const refreshNeeded = useRef(false)
  const epoch = useRef(0)
  const readSequence = useRef(0)
  const attemptId = useRef<string | undefined>(undefined)
  const cancellations = useRef(
    new Map<string, Promise<ChatGPTConnectionState>>(),
  )
  const client = useMemo(() => getAppRpcClient(apiBase), [apiBase])
  const accountsSnapshot = useRef<string | undefined>(undefined)

  const cancelAttempt = useCallback(
    (id: string) => {
      const existing = cancellations.current.get(id)
      if (existing) return existing
      const promise = client.request("chatgpt/cancel", { attemptId: id })
      cancellations.current.set(id, promise)
      void promise.catch(() => cancellations.current.delete(id))
      return promise
    },
    [client],
  )

  const apply = useCallback((next: ChatGPTConnectionState) => {
    attemptId.current =
      next.attempt?.state === "waiting" ? next.attempt.id : undefined
    const snapshot = JSON.stringify(next.accounts)
    if (
      accountsSnapshot.current !== undefined &&
      accountsSnapshot.current !== snapshot
    )
      void useAppStore.getState().loadProviders()
    accountsSnapshot.current = snapshot
    setState(next)
  }, [])

  const refresh = useCallback(async () => {
    if (busy.current) {
      refreshNeeded.current = true
      return
    }
    refreshNeeded.current = false
    const revision = epoch.current
    const sequence = ++readSequence.current
    try {
      const next = await client.request("chatgpt/read", {})
      if (
        !mounted.current ||
        revision !== epoch.current ||
        sequence !== readSequence.current ||
        busy.current
      )
        return
      apply(next)
      setError((previous) =>
        previous === "Could not load ChatGPT connections. Try again."
          ? undefined
          : previous,
      )
    } catch {
      if (
        mounted.current &&
        revision === epoch.current &&
        sequence === readSequence.current
      )
        setError("Could not load ChatGPT connections. Try again.")
    }
  }, [client, apply])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = client.subscribeToProviderChanges(() => void refresh())
    return () => {
      mounted.current = false
      epoch.current++
      unsubscribe()
      const id = attemptId.current
      attemptId.current = undefined
      if (id)
        void cancelAttempt(id).catch(() => {
          useAppStore.setState({
            message:
              "Could not confirm ChatGPT sign-in cancellation. Reopen Providers settings to cancel it.",
          })
        })
    }
  }, [client, refresh, cancelAttempt])

  useEffect(() => {
    if (state?.attempt?.state !== "waiting") return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh()
      if (!stopped) timer = setTimeout(() => void poll(), 1_000)
    }
    timer = setTimeout(() => void poll(), 1_000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [state?.attempt?.state, refresh])

  const close = useCallback(async () => {
    epoch.current++
    setDialog(undefined)
    const id = attemptId.current
    attemptId.current = undefined
    if (!id) return
    busy.current = true
    setPending(true)
    try {
      const next = await cancelAttempt(id)
      if (mounted.current) {
        apply(next)
        setError(undefined)
      }
    } catch {
      if (mounted.current) {
        attemptId.current = id
        setError(
          "Could not confirm sign-in cancellation. Cancel again before starting another sign-in.",
        )
      }
    } finally {
      busy.current = false
      if (mounted.current) {
        setPending(false)
        if (refreshNeeded.current) void refresh()
      }
    }
  }, [apply, cancelAttempt, refresh])

  useEffect(() => {
    if (active) void refresh()
    else void close()
  }, [active, close, refresh])

  const signIn = async (params: { accountId?: string; label?: string }) => {
    if (busy.current || attemptId.current) return
    busy.current = true
    const revision = ++epoch.current
    setPending(true)
    setError(undefined)
    setDialog("attempt")
    setReconnectingAccountId(params.accountId)
    try {
      const next = await client.request("chatgpt/signIn", params)
      // Closing during browser launch must cancel the returned attempt, even
      // after unmount. Never let the late response reopen the panel.
      if (!mounted.current || !visible.current || revision !== epoch.current) {
        if (next.attempt?.state === "waiting") {
          try {
            const cancelled = await cancelAttempt(next.attempt.id)
            if (mounted.current) apply(cancelled)
          } catch {
            if (mounted.current) {
              apply(next)
              setError(
                "Could not confirm sign-in cancellation. Cancel again before starting another sign-in.",
              )
            } else {
              useAppStore.setState({
                message:
                  "Could not confirm ChatGPT sign-in cancellation. Reopen Providers settings to cancel it.",
              })
            }
          }
        }
        return
      }
      setReconnectingAccountId(next.attempt?.accountId ?? params.accountId)
      apply(next)
    } catch {
      if (mounted.current && revision === epoch.current)
        setError(
          "ChatGPT sign-in could not be completed. Try again from this panel.",
        )
    } finally {
      busy.current = false
      if (mounted.current) {
        setPending(false)
        if (revision !== epoch.current || refreshNeeded.current) void refresh()
      }
    }
  }

  const update = async (action: () => Promise<ChatGPTConnectionState>) => {
    if (busy.current || attemptId.current) return
    busy.current = true
    const revision = ++epoch.current
    setPending(true)
    setError(undefined)
    try {
      const next = await action()
      if (!mounted.current || revision !== epoch.current) return
      apply(next)
    } catch {
      if (mounted.current && revision === epoch.current)
        setError("Could not update the ChatGPT connection. Try again.")
    } finally {
      busy.current = false
      if (mounted.current) {
        setPending(false)
        if (revision !== epoch.current || refreshNeeded.current) void refresh()
      }
    }
  }

  return {
    state,
    pending,
    error,
    dialog,
    reconnectingAccountId,
    refresh,
    close,
    signIn,
    open: () => {
      setError(undefined)
      setReconnectingAccountId(undefined)
      setDialog("new")
    },
    signOut: (accountId: string) =>
      update(() => client.request("chatgpt/signOut", { accountId })),
    acknowledge: () =>
      update(async () => {
        const next = await client.request("chatgpt/acknowledge", {})
        if (mounted.current) setDialog(undefined)
        return next
      }),
  }
}
