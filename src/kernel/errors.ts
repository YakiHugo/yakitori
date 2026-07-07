import type { EventMetadata, KernelError as KernelErrorData } from "./events.ts"

export const YakitoriErrorCode = {
  InvalidArgument: "invalid_argument",
  InvalidEventLog: "invalid_event_log",
  InvalidReplay: "invalid_replay",
  InvalidState: "invalid_state",
  NotFound: "not_found",
} as const

export type YakitoriErrorCode =
  (typeof YakitoriErrorCode)[keyof typeof YakitoriErrorCode]

export type YakitoriErrorInput = {
  readonly code: YakitoriErrorCode
  readonly message: string
  readonly details?: EventMetadata
  readonly cause?: unknown
}

export class YakitoriError extends Error {
  readonly code: YakitoriErrorCode
  readonly details?: EventMetadata

  constructor(input: YakitoriErrorInput) {
    super(input.message, { cause: input.cause })
    this.name = "YakitoriError"
    this.code = input.code
    if (input.details !== undefined) this.details = input.details
  }

  toJSON(): KernelErrorData {
    return {
      message: this.message,
      code: this.code,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

export function createYakitoriError(input: YakitoriErrorInput): YakitoriError {
  return new YakitoriError(input)
}

export function isYakitoriError(error: unknown): error is YakitoriError {
  return error instanceof YakitoriError
}
