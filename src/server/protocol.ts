import type {
  EventEnvelope,
  EventMetadata,
  InputRole,
  ModelSelection,
  StoredEventEnvelope,
  TextContent,
} from "../kernel/index.ts"

export const ApiErrorCode = {
  Conflict: "conflict",
  Forbidden: "forbidden",
  InternalError: "internal_error",
  InvalidCursor: "invalid_cursor",
  InvalidInput: "invalid_input",
  NotFound: "not_found",
} as const

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode]

export type ApiErrorResponse = {
  readonly error: {
    readonly code: ApiErrorCode
    readonly message: string
    readonly details?: EventMetadata
  }
}

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

export type ApiCreateSessionRequest = {
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
}

export type ApiCreateSessionResponse = {
  readonly session: ApiSessionDetail
  readonly event: EventEnvelope
}

export type ApiListSessionsRequest = {
  readonly limit?: number
  readonly cursor?: string
}

export type ApiListSessionsResponse = {
  readonly sessions: readonly ApiSessionSummary[]
  readonly nextCursor?: string
}

export type ApiReadSessionRequest = {
  readonly sessionId: string
}

export type ApiReadSessionResponse = {
  readonly session: ApiSessionDetail
}

export type ApiDeleteSessionResponse = {
  readonly sessionId: string
}

export type ApiListProjectsResponse = {
  readonly projects: readonly string[]
}

export type ApiAddProjectResponse = {
  readonly projects: readonly string[]
}

export type ApiProviderModel = {
  readonly id: string
  // Optional: servers before the model-directory work omit it; the GUI falls
  // back to the id.
  readonly displayName?: string
  readonly family: string
  readonly efforts?: readonly string[]
  readonly speeds?: readonly string[]
}

export type ApiProviderSummary = {
  readonly name: string
  readonly defaultModel?: string
  readonly models: readonly ApiProviderModel[]
}

export type ApiUserModelPreference = {
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly speed?: string
}

export type ApiListProvidersResponse = {
  readonly providers: readonly ApiProviderSummary[]
  readonly defaultProvider: string
  readonly defaultModel: string
  readonly userPreference?: ApiUserModelPreference
}

export type ApiUpdateUserModelPreferenceResponse = {
  readonly userPreference: ApiUserModelPreference
}

export type ApiAdmitInputRequest = {
  readonly sessionId: string
  readonly requestId: string
  readonly content: TextContent
  readonly modelSelection?: ModelSelection
  readonly role?: InputRole
  readonly parentInputId?: string
  readonly metadata?: EventMetadata
}

export type ApiAdmitInputResponse = {
  readonly requestId: string
  readonly inputId: string
  readonly event: EventEnvelope
}

export type ApiCancelInputRequest = {
  readonly sessionId: string
  readonly inputId: string
  readonly reason?: string
}

export type ApiCancelInputResponse = {
  readonly sessionId: string
  readonly inputId: string
  readonly event: EventEnvelope
}

export type ApiCancelTurnRequest = {
  readonly sessionId: string
  readonly turnId: string
  readonly reason?: string
}

export type ApiCancelTurnResponse = {
  readonly sessionId: string
  readonly turnId: string
}

export type ApiResolvePermissionRequest = {
  readonly sessionId: string
  readonly turnId: string
  readonly permissionRequestId: string
  readonly behavior: "allow" | "deny"
  readonly reason?: {
    readonly kind: string
    readonly message?: string
  }
}

export type ApiResolvePermissionResponse = {
  readonly sessionId: string
  readonly turnId: string
  readonly permissionRequestId: string
  readonly event: EventEnvelope
}

export type ApiReadSessionEventsRequest = {
  readonly sessionId: string
  readonly after?: number | string
}

export type ApiReadSessionEventsResponse = {
  readonly events: readonly StoredEventEnvelope[]
}

export type ApiSessionSummary = {
  readonly id: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
  readonly mateId?: string
  readonly mateRevisionId?: string
  readonly parentSessionId?: string
  readonly metadata?: EventMetadata
}

export type ApiSessionDetail = ApiSessionSummary & {
  readonly activeTurnId?: string
  readonly counts: {
    readonly inputs: number
    readonly pendingInputs: number
    readonly turns: number
    readonly items: number
    readonly permissions: number
    readonly tools: number
  }
}
