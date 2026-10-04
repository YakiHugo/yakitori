// JSON-RPC names shared by the server sender and the GUI matcher.
// Dependency-free so the browser bundle can import it without node builtins.
export const websocketRpcPath = "/rpc"

export const sessionCompletedMethod = "session/completed"
export const goalChangedMethod = "goal/changed"
export const sideChatChangedMethod = "sideChat/changed"
export const sessionEventMethod = "session/event"
export const sessionTransientMethod = "session/transient"
export const sessionPermissionRequestedMethod = "session/permissionRequested"
export const sessionReplayCompleteMethod = "session/replayComplete"
export const sessionSubscriptionErrorMethod = "session/subscriptionError"
export const sidebarChangedMethod = "sidebar/changed"
export const sessionsActivityMethod = "sessions/activity"
export const sessionQueueChangedMethod = "session/queue/changed"
export const projectChangedMethod = "project/changed"
export const mcpStatusChangedMethod = "mcp/statusChanged"
export const providerConfigurationChangedMethod =
  "provider/configuration/changed"
export const sessionPermissionRequestMethod = "session/permission/request"
