import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js"
import type { ApiAdmitInputResponse } from "../protocol.ts"
import {
  type AnswerQuestionRequest,
  type PendingElicitation,
  UserInteractionError,
} from "../user-interactions.ts"
import { INTERNAL_ERROR, INVALID_PARAMS } from "./messages.ts"
import {
  adaptHandlerResult,
  type RpcMethodDefinition,
  RpcMethodError,
} from "./methods.ts"

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

export const interactionMethods: readonly RpcMethodDefinition[] = [
  "session/question/answer",
  "session/elicitation/list",
  "session/elicitation/answer",
].map((method) => ({
  method,
  scope: () => undefined,
  async invoke(params, context) {
    if (
      typeof params !== "object" ||
      params === null ||
      !("sessionId" in params) ||
      typeof params.sessionId !== "string"
    )
      throw new RpcMethodError(INVALID_PARAMS, "A sessionId is required.")
    const service = context.interactions
    if (service === undefined)
      throw new RpcMethodError(
        INTERNAL_ERROR,
        "User interactions are unavailable.",
      )
    try {
      if (method === "session/elicitation/list")
        return {
          result: { requests: service.elicitations.list(params.sessionId) },
        }
      if (method === "session/elicitation/answer") {
        if (
          !("requestId" in params) ||
          typeof params.requestId !== "string" ||
          !("result" in params)
        )
          throw new RpcMethodError(
            INVALID_PARAMS,
            "A requestId and result are required.",
          )
        const result = ElicitResultSchema.safeParse(params.result)
        if (!result.success)
          throw new RpcMethodError(
            INVALID_PARAMS,
            "Invalid elicitation response.",
          )
        service.elicitations.resolve(
          params.sessionId,
          params.requestId,
          result.data,
        )
        return { result: {} }
      }
      if (
        !("toolCallId" in params) ||
        typeof params.toolCallId !== "string" ||
        !("answers" in params) ||
        !Array.isArray(params.answers) ||
        !params.answers.every(
          (answer): answer is string => typeof answer === "string",
        )
      )
        throw new RpcMethodError(
          INVALID_PARAMS,
          "A toolCallId and answers are required.",
        )
      return {
        result: adaptHandlerResult(
          await service.answer({
            sessionId: params.sessionId,
            toolCallId: params.toolCallId,
            answers: params.answers,
          }),
        ),
      }
    } catch (error) {
      if (error instanceof UserInteractionError)
        throw new RpcMethodError(INVALID_PARAMS, error.message)
      throw error
    }
  },
}))
