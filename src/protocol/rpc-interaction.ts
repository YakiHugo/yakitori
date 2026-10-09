import type { ApiAdmitInputResponse } from "./application.ts"
import type {
  AnswerQuestionRequest,
  PendingElicitation,
} from "./interactions.ts"
export type InteractionRpcParams = {
  "session/question/answer": AnswerQuestionRequest
  "session/elicitation/list": { sessionId: string }
  "session/elicitation/answer": {
    sessionId: string
    requestId: string
    result: import("@modelcontextprotocol/sdk/types.js").ElicitResult
  }
}

export type InteractionRpcResponses = {
  "session/question/answer": ApiAdmitInputResponse
  "session/elicitation/list": { requests: readonly PendingElicitation[] }
  "session/elicitation/answer": Record<string, never>
}
