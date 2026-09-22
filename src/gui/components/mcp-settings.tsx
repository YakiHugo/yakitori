import { Plug, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { RpcMethodResponses } from "../../server/rpc/methods.ts"
import { openUrlTarget } from "../lib/open-resource.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"

type McpServers = RpcMethodResponses["mcp/status"]["servers"]
type McpAction = "login" | "logout" | "reconnect"

const stateLabels = {
  ready: "Connected",
  stopped: "Stopped",
  failed: "Connection failed",
  unconnected: "Not connected",
}

export function McpSettings() {
  const apiBase = useAppStore((state) => state.apiBase)
  const sessionId = useAppStore((state) => state.selectedSession?.id)
  return (
    <McpServerList
      key={`${apiBase}:${sessionId ?? ""}`}
      apiBase={apiBase}
      sessionId={sessionId}
    />
  )
}

function McpServerList({
  apiBase,
  sessionId,
}: Readonly<{ apiBase: string; sessionId: string | undefined }>) {
  const [servers, setServers] = useState<McpServers>()
  const [statusError, setStatusError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [pendingAction, setPendingAction] = useState<{
    name: string
    action: McpAction
  }>()
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh invalidates in-flight reads after user actions.
  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      setRefreshing(true)
      let delay = 5_000
      try {
        const response = await getAppRpcClient(apiBase).request(
          "mcp/status",
          sessionId === undefined ? {} : { sessionId },
        )
        if (!current) return
        setServers(response.servers)
        setStatusError(undefined)
        if (response.servers.some((server) => server.loginState === "pending"))
          delay = 2_000
      } catch (error) {
        if (!current) return
        setStatusError(
          error instanceof Error
            ? error.message
            : "Could not refresh MCP servers.",
        )
      } finally {
        if (current) {
          setRefreshing(false)
          // Schedule after completion so a slow server cannot stack requests.
          timer = setTimeout(() => void refresh(), delay)
        }
      }
    }
    void refresh()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [apiBase, sessionId, refreshRevision])

  const perform = async (name: string, action: McpAction) => {
    setPendingAction({ name, action })
    setActionError(undefined)
    const params = { name, ...(sessionId === undefined ? {} : { sessionId }) }
    try {
      const client = getAppRpcClient(apiBase)
      if (action === "login") {
        const response = await client.request("mcp/login", params)
        if (!mounted.current) return
        await openUrlTarget({ kind: "url", url: response.authorizationUrl })
      } else {
        await client.request(
          action === "logout" ? "mcp/logout" : "mcp/reconnect",
          params,
        )
      }
    } catch (error) {
      if (mounted.current)
        setActionError(
          `${name}: ${error instanceof Error ? error.message : `Could not ${action}.`}`,
        )
    } finally {
      if (mounted.current) {
        setPendingAction(undefined)
        setRefreshRevision((revision) => revision + 1)
      }
    }
  }

  return (
    <>
      <div className="settings-section-heading">
        <Plug size={22} />
        <h3>MCP servers</h3>
        <p>
          {sessionId === undefined
            ? "Tool connections from your global configuration."
            : "Tool connections configured for the current conversation."}
        </p>
      </div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Connection status refreshes while this page is open.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => setRefreshRevision((revision) => revision + 1)}
        >
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      {statusError ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {statusError}
          {servers === undefined ? "" : " Showing the previous status."}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {servers === undefined ? (
        statusError ? null : (
          <p role="status">Loading MCP servers…</p>
        )
      ) : servers.length === 0 ? (
        <p className="settings-hint">No MCP servers configured.</p>
      ) : (
        <ul
          className="settings-group flex flex-col"
          aria-label="Configured MCP servers"
        >
          {servers.map((server) => (
            <li key={server.name} className="settings-row flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="break-all">{server.name}</h4>
                  <Badge
                    variant={
                      server.state === "failed" ? "destructive" : "secondary"
                    }
                  >
                    {server.enabled ? stateLabels[server.state] : "Disabled"}
                  </Badge>
                </div>
                <p>
                  {server.transport === "http" ? "HTTP" : "Local process"} ·{" "}
                  {server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}
                  {server.authenticated ? " · Signed in" : ""}
                </p>
                {server.loginState === "pending" ? (
                  <p role="status">Waiting for sign-in in your browser…</p>
                ) : server.loginState === "failed" ? (
                  <p role="alert">Sign-in failed. Try logging in again.</p>
                ) : null}
                {server.error ? <p role="alert">{server.error}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {server.transport === "http" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`${server.authenticated ? "Log out of" : "Log in to"} ${server.name}`}
                    disabled={
                      pendingAction !== undefined ||
                      (!server.authenticated &&
                        (!server.enabled || server.loginState === "pending"))
                    }
                    onClick={() =>
                      void perform(
                        server.name,
                        server.authenticated ? "logout" : "login",
                      )
                    }
                  >
                    {pendingAction?.name === server.name &&
                    pendingAction.action !== "reconnect"
                      ? "Please wait…"
                      : server.authenticated
                        ? "Log out"
                        : "Log in"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Reconnect ${server.name}`}
                  disabled={!server.enabled || pendingAction !== undefined}
                  onClick={() => void perform(server.name, "reconnect")}
                >
                  {pendingAction?.name === server.name &&
                  pendingAction.action === "reconnect"
                    ? "Connecting…"
                    : "Reconnect"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
