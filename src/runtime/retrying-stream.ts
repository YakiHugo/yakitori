import {
  ModelStopReason,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type StreamFn,
} from "./model.ts"

export type RetryingStreamOptions = {
  readonly maxAttempts?: number
  readonly rateLimitMaxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly retryOnlyBeforeOutput?: boolean
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
  const rateLimitMaxAttempts = options.rateLimitMaxAttempts ?? 2
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 8_000
  const retryOnlyBeforeOutput = options.retryOnlyBeforeOutput ?? true
  const sleep = options.sleep ?? realSleep
  const random = options.random ?? Math.random

  return (request) =>
    streamWithRetries(stream, request, {
      maxAttempts,
      rateLimitMaxAttempts,
      baseDelayMs,
      maxDelayMs,
      retryOnlyBeforeOutput,
      sleep,
      random,
    })
}

type RetryConfig = {
  readonly maxAttempts: number
  readonly rateLimitMaxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly retryOnlyBeforeOutput: boolean
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
  let outputObserved = false
  for await (const event of stream(request)) {
    if (
      event.type === "response" &&
      isRetryableError(event.response) &&
      config.attempt < config.maxAttempts &&
      (!isRateLimit(event.response) ||
        config.attempt < config.rateLimitMaxAttempts) &&
      (!config.retryOnlyBeforeOutput || !outputObserved)
    ) {
      // Only an attempt with no externally visible output is transparent.
      // Once a snapshot escaped, retrying would merge two physical attempts
      // into one logical response without an attempt-reset protocol.
      const delay = retryDelay(event.response, config)
      await config.sleep(delay, request.signal)
      return true
    }
    if (event.type !== "response") outputObserved = true
    yield event
  }
  return false
}

function retryDelay(
  response: ModelResponse,
  config: RetryConfig & { readonly attempt: number },
): number {
  const retryAfterMs = response.error?.details?.retryAfterMs
  if (
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    // Rate-limit hints are server-controlled scheduling constraints and must
    // not be shortened by the generic exponential-backoff ceiling. The
    // provider parser applies the separate 120 s safety bound.
    return isRateLimit(response)
      ? retryAfterMs
      : Math.min(config.maxDelayMs, retryAfterMs)
  }
  return (
    Math.min(
      config.maxDelayMs,
      config.baseDelayMs * 2 ** (config.attempt - 1),
    ) * config.random()
  )
}

function isRateLimit(response: ModelResponse): boolean {
  return (
    response.error?.details?.status === 429 ||
    response.error?.code === "rate_limit_exceeded"
  )
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

// Resolves (never rejects) when the delay elapses or the signal aborts; the
// post-sleep aborted check produces the proper Aborted terminal.
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
