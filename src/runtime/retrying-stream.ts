import {
  ModelStopReason,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type StreamFn,
} from "./model.ts"

export type RetryingStreamOptions = {
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
}

/**
 * Wraps a provider stream with exponential-backoff retries. A retry happens
 * only when the provider itself marked the terminal error as transient via
 * `error.details.retryable === true`; the retry decision stays at the
 * provider boundary, this wrapper only honors it.
 */
export function withRetries(
  stream: StreamFn,
  options: RetryingStreamOptions = {},
): StreamFn {
  const maxAttempts = options.maxAttempts ?? 4
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 8_000
  const sleep = options.sleep ?? realSleep
  const random = options.random ?? Math.random

  return (request) =>
    streamWithRetries(stream, request, {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      sleep,
      random,
    })
}

type RetryConfig = {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly random: () => number
}

async function* streamWithRetries(
  stream: StreamFn,
  request: ModelRequest,
  config: RetryConfig,
): AsyncGenerator<ModelStreamEvent> {
  for (let attempt = 1; ; attempt += 1) {
    if (request.signal?.aborted) {
      yield abortedTerminal()
      return
    }

    const failedRetryably = yield* drainAttempt(stream, request, {
      ...config,
      attempt,
    })
    if (!failedRetryably) return

    if (request.signal?.aborted) {
      yield abortedTerminal()
      return
    }
  }
}

/**
 * Drains one full attempt, yielding its events. Returns true when the attempt
 * ended in a retryable error (terminal discarded, caller may retry) and false
 * when the attempt's terminal was yielded as-is.
 */
async function* drainAttempt(
  stream: StreamFn,
  request: ModelRequest,
  config: RetryConfig & { readonly attempt: number },
): AsyncGenerator<ModelStreamEvent, boolean> {
  for await (const event of stream(request)) {
    if (
      event.type === "response" &&
      isRetryableError(event.response) &&
      config.attempt < config.maxAttempts
    ) {
      // Discard this attempt's terminal and back off before a fresh stream.
      const delay =
        Math.min(
          config.maxDelayMs,
          config.baseDelayMs * 2 ** (config.attempt - 1),
        ) * config.random()
      await config.sleep(delay, request.signal)
      return true
    }
    yield event
  }
  return false
}

function isRetryableError(response: ModelResponse): boolean {
  return (
    response.stopReason === ModelStopReason.Error &&
    response.error?.details?.retryable === true
  )
}

function abortedTerminal(): ModelStreamEvent {
  return {
    type: "response",
    response: { stopReason: ModelStopReason.Aborted, content: [] },
  }
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
