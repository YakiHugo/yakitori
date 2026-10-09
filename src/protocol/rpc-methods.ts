import type {
  ApiAdmitInputRequest,
  ApiAdmitInputResponse,
  ApiCancelInputRequest,
  ApiCancelInputResponse,
  ApiCancelTurnRequest,
  ApiCancelTurnResponse,
  ApiClearGoalResponse,
  ApiCompactSessionResponse,
  ApiCreateProjectResponse,
  ApiCreateSessionRequest,
  ApiCreateSessionResponse,
  ApiDeleteSessionResponse,
  ApiForkSessionRequest,
  ApiForkSessionResponse,
  ApiListAgentsResponse,
  ApiListProjectsResponse,
  ApiListProvidersResponse,
  ApiListSessionsResponse,
  ApiListSkillsResponse,
  ApiPendingPermission,
  ApiReadGoalResponse,
  ApiReadProjectResponse,
  ApiReadSessionRequest,
  ApiReadSessionResponse,
  ApiReadSubscriptionRequest,
  ApiReadSubscriptionResponse,
  ApiReadUsageResponse,
  ApiResolvePermissionRequest,
  ApiSearchSessionOccurrencesRequest,
  ApiSearchSessionOccurrencesResponse,
  ApiSearchSessionsRequest,
  ApiSearchSessionsResponse,
  ApiServerDiagnostics,
  ApiSetGoalRequest,
  ApiSetGoalResponse,
  ApiSteerInputRequest,
  ApiSteerInputResponse,
  ApiUpdateProjectResponse,
  ApiUpdateUserModelPreferenceResponse,
  ApiUserModelPreference,
} from "./application.ts"
import type { ConfigurationSnapshot } from "./configuration.ts"
import type { ComputerUseStatus } from "./connections.ts"
import type { EngineRpcParams, EngineRpcResponses } from "./engine.ts"
import type { AppSessionEventEnvelope } from "./events.ts"
import type { ThreadGoal } from "./goal.ts"
import type { QueuedInput } from "./input-queue.ts"
import type { ChatGPTRpcParams, ChatGPTRpcResponses } from "./rpc-chatgpt.ts"
import type {
  InteractionRpcParams,
  InteractionRpcResponses,
} from "./rpc-interaction.ts"
import type { McpRpcParams, McpRpcResponses } from "./rpc-mcp.ts"
import type { ProviderRpcParams, ProviderRpcResponses } from "./rpc-provider.ts"
import type {
  SideChatRpcParams,
  SideChatRpcResponses,
} from "./rpc-side-chat.ts"
import type {
  WorkspaceRpcParams,
  WorkspaceRpcResponses,
} from "./rpc-workspace.ts"
import type { SessionSidebar, SidebarChange } from "./sidebar.ts"
import type { WorkspaceReadResponse } from "./workspace.ts"
export type InitializeParams = Readonly<{
  clientInfo: Readonly<{ name: string; version: string }>
  capabilities?: Readonly<{
    experimentalApi?: boolean
    optOutNotificationMethods?: readonly string[]
  }>
}>

export type InitializeResponse = Readonly<{
  userAgent: string
  platformFamily: string
  platformOs: string
}>

export type SessionListParams = Readonly<{
  archived?: boolean
  sectionId?: string | null
  cursor?: string
  limit?: number
  workingDirectory?: string
  projectId?: string
}>

export type SessionSubscribeParams = Readonly<{
  sessionId: string
  after?: number
}>

export type SessionSubscribeResponse = ApiReadSessionResponse

export type SessionUnsubscribeParams = Readonly<{ sessionId: string }>

export type ProjectListParams = Readonly<{
  cursor?: string
  limit?: number
}>

export type ProjectReadParams = Readonly<{ projectId: string }>

export type ProjectCreateParams = Readonly<{
  name?: string
  roots: readonly string[]
  idempotencyKey?: string
}>

export type ProjectUpdateParams = Readonly<{
  projectId: string
  name?: string
  roots?: readonly string[]
  metadata?: Readonly<Record<string, string>>
  pinned?: boolean
}>

export type ProjectMoveParams = Readonly<{
  projectId: string
  toPosition: number
}>

export type ProjectDeleteParams = Readonly<{ projectId: string }>

export type ConfigReadParams = Readonly<{ cwd?: string }>

export type ConfigWriteParams = Readonly<{
  keyPath: readonly string[]
  value: unknown
  expectedVersion?: string
  cwd?: string
}>

export type SessionEventNotification = Readonly<{
  sessionId: string
  seq: number
  event: AppSessionEventEnvelope
}>

export type SessionCompletedNotification = Readonly<{
  sessionId: string
  turnId: string
  title?: string
}>

export type GoalChangedNotification = Readonly<{
  sessionId: string
  goal: ThreadGoal | null
}>

export type SessionReplayCompleteNotification = Readonly<{
  sessionId: string
  seq: number
}>

export type SessionSubscriptionErrorNotification = Readonly<{
  sessionId: string
  message: string
}>

export type ProjectChangeType = "created" | "updated" | "deleted"

export type ProjectChangedNotification = Readonly<{
  projectId: string
  changeType: ProjectChangeType
}>

export type SidebarChangedNotification = Readonly<{
  sidebar?: SessionSidebar
  sessionId?: string
}>

export type McpStatusChangedNotification = Readonly<{
  sessionId: string
}>

export type SessionPermissionRequestParams = Readonly<
  { sessionId: string } & ApiPendingPermission
>

export type SessionPermissionRequestResult = Readonly<
  Pick<ApiResolvePermissionRequest, "behavior" | "reason">
>

export type RpcMethodParams = Readonly<
  EngineRpcParams &
    ChatGPTRpcParams &
    ProviderRpcParams &
    WorkspaceRpcParams &
    InteractionRpcParams &
    McpRpcParams &
    SideChatRpcParams & {
      "computer/status": Readonly<Record<string, never>>
      "computer/connect": Readonly<Record<string, never>>
      "computer/disconnect": Readonly<Record<string, never>>
      initialize: InitializeParams
      "server/ping": Readonly<Record<string, never>>
      "server/diagnostics": Readonly<Record<string, never>>
      "sidebar/read": Readonly<Record<string, never>>
      "sidebar/update": SidebarChange
      "goal/read": ApiReadSessionRequest
      "goal/set": ApiSetGoalRequest
      "goal/clear": ApiReadSessionRequest
      "usage/read": Readonly<Record<string, never>>
      "session/list": SessionListParams
      "agent/list": ApiReadSessionRequest
      "session/search": ApiSearchSessionsRequest
      "session/searchOccurrences": ApiSearchSessionOccurrencesRequest
      "session/create": ApiCreateSessionRequest
      "session/read": ApiReadSessionRequest
      "session/skills": Readonly<{ sessionId?: string; projectId?: string }>
      "session/skill/read": Readonly<{
        sessionId?: string
        projectId?: string
        path: string
        offset?: number
        limit?: number
      }>
      "session/delete": ApiReadSessionRequest
      "session/close": ApiReadSessionRequest
      "session/fork": ApiForkSessionRequest & Readonly<{ sessionId: string }>
      "session/compact": Readonly<{ sessionId: string; requestId?: string }>
      "session/input": ApiAdmitInputRequest
      "session/input/queue": ApiAdmitInputRequest
      "session/queue/list": ApiReadSessionRequest
      "session/queue/update": ApiAdmitInputRequest &
        Readonly<{ inputId: string }>
      "session/queue/reorder": Readonly<{
        sessionId: string
        inputIds: readonly string[]
      }>
      "session/queue/start": Readonly<{ sessionId: string; inputId?: string }>
      "session/input/steer": ApiSteerInputRequest
      "session/input/cancel": ApiCancelInputRequest
      "session/turn/cancel": ApiCancelTurnRequest
      "session/subscribe": SessionSubscribeParams
      "session/unsubscribe": SessionUnsubscribeParams
      "project/list": ProjectListParams
      "project/read": ProjectReadParams
      "project/open": Readonly<{ path: string; name?: string }>
      "project/create": ProjectCreateParams
      "project/update": ProjectUpdateParams
      "project/move": ProjectMoveParams
      "project/delete": ProjectDeleteParams
      "provider/list": Readonly<Record<string, never>>
      "subscription/read": ApiReadSubscriptionRequest
      "config/read": ConfigReadParams
      "config/write": ConfigWriteParams
      "userPreference/write": ApiUserModelPreference
    }
>

export type RpcMethodResponses = Readonly<
  EngineRpcResponses &
    ChatGPTRpcResponses &
    ProviderRpcResponses &
    WorkspaceRpcResponses &
    InteractionRpcResponses &
    McpRpcResponses &
    SideChatRpcResponses & {
      "computer/status": ComputerUseStatus
      "computer/connect": ComputerUseStatus
      "computer/disconnect": ComputerUseStatus
      initialize: InitializeResponse
      "server/ping": Readonly<Record<string, never>>
      "server/diagnostics": ApiServerDiagnostics
      "sidebar/read": SessionSidebar
      "sidebar/update": SessionSidebar
      "goal/read": ApiReadGoalResponse
      "goal/set": ApiSetGoalResponse
      "goal/clear": ApiClearGoalResponse
      "usage/read": ApiReadUsageResponse
      "session/list": ApiListSessionsResponse
      "agent/list": ApiListAgentsResponse
      "session/search": ApiSearchSessionsResponse
      "session/searchOccurrences": ApiSearchSessionOccurrencesResponse
      "session/create": ApiCreateSessionResponse
      "session/read": ApiReadSessionResponse
      "session/skills": ApiListSkillsResponse
      "session/skill/read": WorkspaceReadResponse
      "session/delete": ApiDeleteSessionResponse
      "session/close": ApiDeleteSessionResponse
      "session/fork": ApiForkSessionResponse
      "session/compact": ApiCompactSessionResponse
      "session/input": ApiAdmitInputResponse
      "session/input/queue": ApiAdmitInputResponse
      "session/queue/list": Readonly<{ items: readonly QueuedInput[] }>
      "session/queue/update": Readonly<{ item: QueuedInput }>
      "session/queue/reorder": Readonly<{ items: readonly QueuedInput[] }>
      "session/queue/start": ApiAdmitInputResponse
      "session/input/steer": ApiSteerInputResponse
      "session/input/cancel": ApiCancelInputResponse
      "session/turn/cancel": ApiCancelTurnResponse
      "session/subscribe": SessionSubscribeResponse
      "session/unsubscribe": Readonly<Record<string, never>>
      "project/list": ApiListProjectsResponse
      "project/read": ApiReadProjectResponse
      "project/open": ApiCreateProjectResponse
      "project/create": ApiCreateProjectResponse
      "project/update": ApiUpdateProjectResponse
      "project/move": Readonly<Record<string, never>>
      "project/delete": Readonly<Record<string, never>>
      "provider/list": ApiListProvidersResponse
      "subscription/read": ApiReadSubscriptionResponse
      "config/read": ConfigurationSnapshot
      "config/write": ConfigurationSnapshot
      "userPreference/write": ApiUpdateUserModelPreferenceResponse
    }
>
