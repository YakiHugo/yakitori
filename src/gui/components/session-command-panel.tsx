import { Gauge, Server } from "lucide-react"
import { useEffect, useState } from "react"
import type { ApiSubscriptionProvider } from "../../server/protocol.ts"
import type { RpcMethodResponses } from "../../server/rpc/methods.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore, useExecutionView } from "../store/app-store.ts"

type McpServers = RpcMethodResponses["mcp/status"]["servers"]
type Subscription = RpcMethodResponses["subscription/read"]["subscription"]

const subscriptionProviders = new Set(["codex", "grok", "kimi"])
const number = new Intl.NumberFormat()

export function SessionCommandPanel() {
  const panel = useAppStore((state) => state.commandPanel)
  const selectedId = useAppStore((state) => state.selection.sessionId)
  if (!panel || panel.sessionId !== selectedId) return null
  return (
    <CommandPanel
      key={`${selectedId ?? "draft"}:${panel.kind}`}
      kind={panel.kind}
    />
  )
}

function CommandPanel({ kind }: Readonly<{ kind: "status" | "mcp" }>) {
  const apiBase = useAppStore((state) => state.apiBase)
  const session = useAppStore((state) => state.selectedSession)
  const selectedId = useAppStore((state) => state.selection.sessionId)
  const providers = useAppStore((state) => state.providers)
  const close = useAppStore((state) => state.closeCommandPanel)
  const view = useExecutionView()
  const [servers, setServers] = useState<McpServers>()
  const [subscriptionResult, setSubscriptionResult] =
    useState<
      Readonly<{
        apiBase: string
        provider: ApiSubscriptionProvider
        subscription?: Subscription
        error?: string
      }>
    >()
  const [mcpError, setMcpError] = useState<string>()
  const model = view.lastModel ?? session?.currentModel
  const contextTokens = view.contextTokens
  const usageModel =
    contextTokens?.provider !== undefined && contextTokens?.model !== undefined
      ? { provider: contextTokens.provider, model: contextTokens.model }
      : model
  const capacity =
    contextTokens?.capacityTokens ??
    providers
      .find((provider) => provider.name === usageModel?.provider)
      ?.models.find((entry) => entry.id === usageModel?.model)
      ?.effectiveContextWindowTokens
  const activeTokens = contextTokens?.activeContextTokens
  const usedPercent =
    capacity !== undefined && activeTokens !== undefined
      ? Math.min(100, (activeTokens / capacity) * 100)
      : undefined
  const subscriptionProvider =
    model?.provider && subscriptionProviders.has(model.provider)
      ? (model.provider as ApiSubscriptionProvider)
      : undefined

  const currentSubscriptionResult =
    subscriptionResult?.apiBase === apiBase &&
    subscriptionResult.provider === subscriptionProvider
      ? subscriptionResult
      : undefined
  const subscription = currentSubscriptionResult?.subscription
  const error = kind === "mcp" ? mcpError : currentSubscriptionResult?.error

  useEffect(() => {
    let current = true
    const client = getAppRpcClient(apiBase)
    if (kind === "mcp") {
      let sequence = 0
      const refresh = () => {
        const request = ++sequence
        void client
          .request("mcp/status", selectedId ? { sessionId: selectedId } : {})
          .then(
            (response) => {
              if (current && request === sequence) {
                setServers(response.servers)
                setMcpError(undefined)
              }
            },
            (cause: unknown) => {
              if (current && request === sequence)
                setMcpError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not load MCP servers.",
                )
            },
          )
      }
      refresh()
      const unsubscribe = client.subscribeToMcpStatusChanges((change) => {
        if (change.sessionId === selectedId || change.sessionId === undefined)
          refresh()
      })
      return () => {
        current = false
        unsubscribe()
      }
    }
    if (!subscriptionProvider) return
    setSubscriptionResult({ apiBase, provider: subscriptionProvider })
    void client
      .request("subscription/read", { provider: subscriptionProvider })
      .then(
        (response) => {
          if (current)
            setSubscriptionResult({
              apiBase,
              provider: subscriptionProvider,
              subscription: response.subscription,
            })
        },
        (cause: unknown) => {
          if (current)
            setSubscriptionResult({
              apiBase,
              provider: subscriptionProvider,
              error:
                cause instanceof Error
                  ? cause.message
                  : "Could not load usage limits.",
            })
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, kind, selectedId, subscriptionProvider])

  return (
    <section
      aria-label={kind === "mcp" ? "MCP status" : "Session status"}
      className="max-h-[min(19rem,35vh)] overflow-y-auto px-4 py-3 text-sm"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {kind === "mcp" ? (
            <Server
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          ) : (
            <Gauge
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          )}
          {kind === "mcp" ? "MCP servers" : "Status"}
        </h3>
        <button
          type="button"
          onClick={close}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Close
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-destructive">
          {error}
        </p>
      )}
      {kind === "mcp" ? (
        servers === undefined ? (
          error ? null : (
            <p role="status" className="text-muted-foreground">
              Loading MCP servers…
            </p>
          )
        ) : servers.length === 0 ? (
          <p className="text-muted-foreground">No MCP servers configured.</p>
        ) : (
          <ul className="space-y-3">
            {servers.map((server) => (
              <li key={server.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-xs font-medium">
                    {server.name}
                  </span>
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {server.enabled ? server.state : "disabled"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {server.transport === "http" ? "HTTP" : "Local process"} ·{" "}
                  {server.toolCount} tools
                  {server.authenticated ? " · Signed in" : ""}
                  {server.loginState === "pending" ? " · Sign-in pending" : ""}
                </p>
                {server.error && (
                  <p className="mt-1 text-xs text-destructive">
                    {server.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Conversation</dt>
            <dd className="min-w-0 break-all font-mono text-xs">
              {session?.id ?? "No conversation selected"}
            </dd>
            <dt className="text-muted-foreground">Context</dt>
            <dd>
              {activeTokens === undefined
                ? "Available after a model response"
                : `${number.format(activeTokens)} tokens in the last model context`}
              {capacity !== undefined && (
                <span className="text-muted-foreground">
                  {" "}
                  / {number.format(capacity)} model window
                  {usedPercent !== undefined &&
                    ` · ${Math.max(0, Math.round(100 - usedPercent))}% remaining`}
                </span>
              )}
              {usedPercent !== undefined && (
                <span
                  aria-hidden="true"
                  className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${usedPercent}%` }}
                  />
                </span>
              )}
            </dd>
          </dl>
          <div className="pt-1">
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">
              {subscriptionProvider
                ? `${subscriptionProvider} usage limits`
                : "Usage limits"}
            </h4>
            {subscriptionProvider === undefined ? (
              <p className="text-xs text-muted-foreground">
                This provider does not report subscription limits here.
              </p>
            ) : subscription === undefined ? (
              <p role="status" className="text-xs text-muted-foreground">
                {error ? "Usage limits unavailable." : "Loading usage limits…"}
              </p>
            ) : subscription.usage.status !== "available" ? (
              <p className="text-xs text-muted-foreground">
                Usage limits unavailable for this connection.
              </p>
            ) : subscription.usage.buckets.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No usage limits reported.
              </p>
            ) : (
              <ul className="space-y-3">
                {subscription.usage.buckets.map((bucket) => {
                  const remaining = Math.max(0, 100 - bucket.usedPercent)
                  return (
                    <li key={bucket.name}>
                      <div className="mb-1 flex justify-between gap-3 text-xs">
                        <span>{bucket.name}</span>
                        <span className="text-right text-muted-foreground">
                          {Math.round(remaining)}% remaining
                          {bucket.resetsAt
                            ? ` · resets ${new Date(bucket.resetsAt).toLocaleString()}`
                            : ""}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{
                            width: `${Math.min(100, bucket.usedPercent)}%`,
                          }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
