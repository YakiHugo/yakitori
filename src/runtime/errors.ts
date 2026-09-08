import type { ModelError } from "./model.ts"

export class ModelResponseError extends Error {
  readonly providerError: ModelError | undefined
  constructor(error: ModelError | undefined) {
    super(error?.message ?? "Model returned an error.")
    this.name = "ModelResponseError"
    this.providerError = error
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
