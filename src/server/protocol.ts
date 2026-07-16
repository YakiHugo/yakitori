import type {
  EventEnvelope,
  EventMetadata,
  InputRole,
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

export type ApiAdmitInputRequest = {
  readonly sessionId: string
  readonly requestId: string
  readonly content: TextContent
  readonly role?: InputRole
  readonly parentInputId?: string
  readonly metadata?: EventMetadata
}

export type ApiAdmitInputResponse = {
  readonly requestId: string
  readonly inputId: string
  readonly event: EventEnvelope
}

export type ApiReadSessionEventsRequest = {
  readonly sessionId: string
  readonly after?: number | string
}

export type ApiReadSessionEventsResponse = {
  readonly events: readonly EventEnvelope[]
  readonly lastSequence: number
}

export type ApiSessionSummary = {
  readonly id: string
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly title?: string
  readonly workingDirectory?: string
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
