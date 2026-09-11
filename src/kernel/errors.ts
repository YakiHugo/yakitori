import type { EventMetadata, KernelError } from "./events.ts"

export const YakitoriErrorCode = {
  InvalidArgument: "invalid_argument",
  InvalidEventLog: "invalid_event_log",
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
}

export function createYakitoriError(input: YakitoriErrorInput): YakitoriError {
  return new YakitoriError(input)
}

export function isYakitoriError(error: unknown): error is YakitoriError {
  return error instanceof YakitoriError
}

export class KernelErrorException extends Error {
  readonly kernelError: KernelError

  constructor(kernelError: KernelError, options: ErrorOptions = {}) {
    super(kernelError.message, options)
    this.name = "KernelErrorException"
    this.kernelError = kernelError
  }
}

export function kernelErrorFromUnknown(error: unknown): KernelError {
  if (error instanceof KernelErrorException) return error.kernelError
  return {
    message: error instanceof Error ? error.message : "Turn execution failed.",
  }
}
