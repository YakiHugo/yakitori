import { KernelErrorException } from "../kernel/index.ts"
import type { ModelFailure } from "./model.ts"

export class ModelFailureError extends KernelErrorException {
  readonly failure: ModelFailure

  constructor(failure: ModelFailure, options: ErrorOptions = {}) {
    super(
      {
        message: failure.message,
        code: `model.${failure.kind}`,
        details: {
          kind: failure.kind,
          stage: failure.stage,
          provider: failure.provider,
          wireApi: failure.wireApi,
          ...(failure.status === undefined ? {} : { status: failure.status }),
          ...(failure.providerCode === undefined
            ? {}
            : { providerCode: failure.providerCode }),
          ...(failure.providerRequestId === undefined
            ? {}
            : { providerRequestId: failure.providerRequestId }),
          ...(failure.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: failure.retryAfterMs }),
          ...(failure.serverShouldRetry === undefined
            ? {}
            : { serverShouldRetry: failure.serverShouldRetry }),
          ...(failure.attempt === undefined
            ? {}
            : { attempt: failure.attempt }),
          ...(failure.maxAttempts === undefined
            ? {}
            : { maxAttempts: failure.maxAttempts }),
          ...(failure.outputObserved === undefined
            ? {}
            : { outputObserved: failure.outputObserved }),
          ...(failure.retryDecision === undefined
            ? {}
            : { retryDecision: failure.retryDecision }),
          ...(failure.details === undefined
            ? {}
            : { providerDetails: failure.details }),
        },
      },
      options,
    )
    this.name = "ModelFailureError"
    this.failure = failure
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  )
}
