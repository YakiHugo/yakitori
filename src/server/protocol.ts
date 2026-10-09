import type { ApiErrorResponse } from "../protocol/application.ts"

export {
  type ApiAdmitInputRequest,
  type ApiAdmitInputResponse,
  type ApiCancelInputRequest,
  type ApiCancelInputResponse,
  type ApiCancelTurnRequest,
  type ApiCancelTurnResponse,
  type ApiClearGoalResponse,
  type ApiCompactSessionResponse,
  type ApiCreateProjectResponse,
  type ApiCreateSessionRequest,
  type ApiCreateSessionResponse,
  type ApiDeleteSessionResponse,
  ApiErrorCode,
  type ApiErrorResponse,
  type ApiForkSessionRequest,
  type ApiForkSessionResponse,
  type ApiListAgentsResponse,
  type ApiListProjectsResponse,
  type ApiListProvidersResponse,
  type ApiListSessionsResponse,
  type ApiListSkillsResponse,
  type ApiPendingInput,
  type ApiPendingPermission,
  type ApiProject,
  type ApiProviderModel,
  type ApiProviderSummary,
  type ApiRateLimits,
  type ApiReadGoalResponse,
  type ApiReadProjectResponse,
  type ApiReadSessionEventsResponse,
  type ApiReadSessionRequest,
  type ApiReadSessionResponse,
  type ApiReadSubscriptionRequest,
  type ApiReadSubscriptionResponse,
  type ApiReadUsageResponse,
  type ApiResolvePermissionRequest,
  type ApiResolvePermissionResponse,
  type ApiSearchSessionOccurrencesRequest,
  type ApiSearchSessionOccurrencesResponse,
  type ApiSearchSessionsRequest,
  type ApiSearchSessionsResponse,
  type ApiServerDiagnostics,
  type ApiSessionDetail,
  type ApiSessionSummary,
  type ApiSetGoalRequest,
  type ApiSetGoalResponse,
  type ApiSkillSummary,
  type ApiSteerInputRequest,
  type ApiSteerInputResponse,
  type ApiSubscriptionProvider,
  type ApiSubscriptionSummary,
  type ApiUpdateProjectResponse,
  type ApiUpdateUserModelPreferenceResponse,
  type ApiUserModelPreference,
} from "../protocol/application.ts"

export type ApiHandlerResult<T> =
  | {
      readonly ok: true
      readonly status: number
      readonly body: T
    }
  | {
      readonly ok: false
      readonly status: number
      readonly body: ApiErrorResponse
    }
