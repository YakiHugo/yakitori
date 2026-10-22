import type { EventMetadata } from "../kernel/index.ts"
import { ApiErrorCode } from "./protocol.ts"

export class ApiBoundaryError extends Error {
  readonly code: ApiErrorCode
  readonly details?: EventMetadata

  constructor(code: ApiErrorCode, message: string, details?: EventMetadata) {
    super(message)
    this.name = "ApiBoundaryError"
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function invalidInput(
  message: string,
  details?: EventMetadata,
): ApiBoundaryError {
  return new ApiBoundaryError(ApiErrorCode.InvalidInput, message, details)
}
