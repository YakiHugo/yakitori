import { createHash, randomUUID } from "node:crypto"
import type {
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js"
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { ThreadStore } from "../core/thread-store.ts"
import { parseUserQuestions } from "../kernel/user-interaction.ts"
import type { ServerHandlers } from "./handlers.ts"
import type { ApiAdmitInputResponse, ApiHandlerResult } from "./protocol.ts"

export type PendingElicitation = Readonly<{
  requestId: string
  serverName: string
  params: ElicitRequest["params"]
}>

export class UserInteractionError extends Error {}

export function createElicitationBroker() {
  const pending = new Map<
    string,
    {
      sessionId: string
      request: PendingElicitation
      finish(result: ElicitResult): void
      validate(content: unknown): void
    }
  >()
  return {
    request(
      sessionId: string,
      serverName: string,
      params: ElicitRequest["params"],
      signal: AbortSignal,
    ): Promise<ElicitResult> {
      signal.throwIfAborted()
      const requestId = randomUUID()
      const validator =
        params.mode === "url"
          ? undefined
          : new AjvJsonSchemaValidator().getValidator(
              params.requestedSchema as JsonSchemaType,
            )
      return new Promise((resolve) => {
        const finish = (result: ElicitResult) => {
          if (!pending.delete(requestId)) return
          signal.removeEventListener("abort", cancel)
          resolve(result)
        }
        const cancel = () => finish({ action: "cancel" })
        pending.set(requestId, {
          sessionId,
          request: { requestId, serverName, params },
          finish,
          validate(content) {
            const result = validator?.(content)
            if (result !== undefined && !result.valid)
              throw new UserInteractionError(
                result.errorMessage ?? "Invalid form response.",
              )
          },
        })
        signal.addEventListener("abort", cancel, { once: true })
        if (signal.aborted) cancel()
      })
    },
    list(sessionId: string): readonly PendingElicitation[] {
      return [...pending.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.request)
    },
    resolve(sessionId: string, requestId: string, result: ElicitResult): void {
      const entry = pending.get(requestId)
      if (entry === undefined || entry.sessionId !== sessionId)
        throw new UserInteractionError(
          "This request is no longer waiting for an answer.",
        )
      if (result.action === "accept") entry.validate(result.content ?? {})
      entry.finish(result)
    },
    cancelSession(sessionId: string): void {
      for (const entry of pending.values())
        if (entry.sessionId === sessionId) entry.finish({ action: "cancel" })
    },
    close(): void {
      for (const entry of pending.values()) entry.finish({ action: "cancel" })
    },
  }
}

export type ElicitationBroker = ReturnType<typeof createElicitationBroker>

export type AnswerQuestionRequest = Readonly<{
  sessionId: string
  toolCallId: string
  answers: readonly string[]
}>

export function createSessionInteractions(
  store: ThreadStore,
  handlers: Pick<ServerHandlers, "admitInput">,
  elicitations: ElicitationBroker,
) {
  return {
    elicitations,
    async answer(
      request: AnswerQuestionRequest,
    ): Promise<ApiHandlerResult<ApiAdmitInputResponse>> {
      const stored = await store.readThread(request.sessionId)
      const completed = stored?.rollout.find(
        ({ item }) =>
          item.type === "item_completed" &&
          "toolCallId" in item.item &&
          item.item.toolCallId === request.toolCallId &&
          item.item.name === "request_user_input_async" &&
          item.item.error === undefined,
      )?.item
      const questions =
        completed?.type === "item_completed" && "output" in completed.item
          ? parseUserQuestions(completed.item.output)
          : undefined
      if (questions === undefined)
        throw new UserInteractionError(
          "The question request was not found in this conversation.",
        )
      if (
        request.answers.length !== questions.questions.length ||
        request.answers.some(
          (answer) => typeof answer !== "string" || answer.trim() === "",
        )
      )
        throw new UserInteractionError(
          "Answer each question before submitting.",
        )
      // Admission owns deduplication and its durable persistence barrier. The
      // same question cannot enqueue another answer after reconnect or restart.
      return handlers.admitInput({
        sessionId: request.sessionId,
        requestId: `question_${createHash("sha256").update(request.toolCallId).digest("hex")}`,
        role: "user",
        content: {
          kind: "text",
          text: questions.questions
            .map(
              (question, index) =>
                `${question.title}\n${request.answers[index]}`,
            )
            .join("\n\n"),
        },
        metadata: {
          userQuestionId: request.toolCallId,
          userQuestionAnswers: request.answers,
        },
      })
    },
  }
}

export type SessionInteractions = ReturnType<typeof createSessionInteractions>
