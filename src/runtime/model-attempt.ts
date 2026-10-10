import type { ModelAttemptRecord } from "../core/rollout.ts"
import { kernelErrorFromUnknown } from "../kernel/errors.ts"
import { ModelFailureError } from "./errors.ts"
import type {
  ModelResponseOrigin,
  ModelStreamEvent,
  ModelTarget,
  ModelWireApi,
} from "./model.ts"

export function createModelAttemptTracker(
  record: (attempt: ModelAttemptRecord) => Promise<void>,
  target: ModelTarget,
  wireApi: ModelWireApi = "unknown",
) {
  let origin: ModelResponseOrigin = {
    callId: `model_call_${globalThis.crypto.randomUUID()}`,
    attemptId: `model_attempt_${globalThis.crypto.randomUUID()}`,
    attempt: 1,
    provider: target.provider,
    model: target.model,
  }
  let ended = false
  return {
    get origin() {
      return origin
    },
    async end(
      event: Extract<
        ModelStreamEvent,
        { type: "response" | "retry" | "failure" | "cancelled" }
      >,
    ) {
      if (ended) throw new Error("Model attempt ended more than once.")
      ended = true
      const response = event.type === "response" ? event.response : undefined
      const failure =
        event.type === "failure" || event.type === "retry"
          ? event.failure
          : undefined
      const providerRequestId =
        response?.providerRequestId ?? failure?.providerRequestId
      const providerResponseId =
        response?.providerResponseId ?? failure?.providerResponseId
      const usage =
        response?.usage ?? (event.type === "response" ? undefined : event.usage)
      await record({
        origin,
        wireApi,
        outcome:
          event.type === "response"
            ? "completed"
            : event.type === "failure"
              ? "failed"
              : event.type,
        ...(providerResponseId === undefined ? {} : { providerResponseId }),
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        ...(response?.nativeMetadata === undefined
          ? {}
          : { responseMetadata: response.nativeMetadata }),
        ...(response === undefined
          ? {}
          : {
              stopReason: response.stopReason,
              ...(response.rawStopReason === undefined
                ? {}
                : { rawStopReason: response.rawStopReason }),
              ...(response.lengthReason === undefined
                ? {}
                : { lengthReason: response.lengthReason }),
              ...(response.incompleteToolCalls === undefined
                ? {}
                : { incompleteToolCalls: response.incompleteToolCalls }),
            }),
        ...(usage === undefined ? {} : { usage }),
        ...(failure === undefined
          ? {}
          : { error: kernelErrorFromUnknown(new ModelFailureError(failure)) }),
      })
    },
    retry(nextAttempt: number) {
      if (!ended || nextAttempt !== origin.attempt + 1)
        throw new Error("Invalid model attempt transition.")
      origin = {
        ...origin,
        attempt: nextAttempt,
        attemptId: `model_attempt_${globalThis.crypto.randomUUID()}`,
      }
      ended = false
    },
    async fail(error: unknown, cancelled: boolean) {
      if (ended) return
      ended = true
      await record({
        origin,
        wireApi,
        outcome: cancelled ? "cancelled" : "failed",
        ...(cancelled ? {} : { error: kernelErrorFromUnknown(error) }),
      })
    },
  }
}
