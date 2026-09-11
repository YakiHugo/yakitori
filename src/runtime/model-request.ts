import { modelFailureFromUnknown } from "./model-failure.ts"
import type { ModelRequestPolicy } from "../kernel/index.ts"
import type {
  ModelFailure,
  ModelRequest,
  ModelStreamEvent,
  ModelWireApi,
  StreamFn,
} from "./model.ts"

export type { ModelRequestPolicy } from "../kernel/index.ts"

// Node timers overflow above a signed 32-bit millisecond delay and otherwise
// run almost immediately. This is an implementation safety boundary, not a
// provider or product quota.
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export type ModelRequestOptions = ModelRequestPolicy & {
  readonly wireApi: ModelWireApi
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly retryAfterOutput?: boolean
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
}

type ResolvedModelRequestOptions = Required<
  Omit<ModelRequestOptions, "sleep" | "random">
> & {
  readonly sleep: NonNullable<ModelRequestOptions["sleep"]>
  readonly random: NonNullable<ModelRequestOptions["random"]>
}

export function createModelRequestStream(
  stream: StreamFn,
  options: ModelRequestOptions,
): StreamFn {
  const resolved: ResolvedModelRequestOptions = {
    wireApi: options.wireApi,
    maxAttempts: options.maxAttempts ?? 4,
    rateLimitMaxAttempts: options.rateLimitMaxAttempts ?? 2,
    baseDelayMs: options.baseDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 8_000,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 300_000,
    retryAfterOutput: options.retryAfterOutput ?? false,
    sleep: options.sleep ?? realSleep,
    random: options.random ?? Math.random,
  }
  validateOptions(resolved)
  return (request) => runModelRequest(stream, request, resolved)
}

async function* runModelRequest(
  stream: StreamFn,
  request: ModelRequest,
  options: ResolvedModelRequestOptions,
): AsyncGenerator<ModelStreamEvent> {
  let outputObserved = false
  let previousFailure: ModelFailure | undefined
  for (let attempt = 1; ; attempt += 1) {
    if (request.signal?.aborted) {
      yield { type: "cancelled" }
      return
    }

    const attemptController = new AbortController()
    const signal = request.signal
      ? AbortSignal.any([request.signal, attemptController.signal])
      : attemptController.signal
    let iterator: AsyncIterator<ModelStreamEvent> | undefined
    let stage: "connect" | "response_body" = "connect"
    let exhausted = false
    let closeStarted = false
    let pendingNext = false
    let terminalEvent:
      | Extract<ModelStreamEvent, { readonly type: "response" }>
      | undefined
    let failureEvent:
      | Extract<ModelStreamEvent, { readonly type: "failure" }>
      | undefined
    try {
      try {
        iterator = stream({
          ...request,
          attempt: {
            number: attempt,
            maxAttempts: options.maxAttempts,
            ...(previousFailure === undefined ? {} : { previousFailure }),
          },
          signal,
        })[Symbol.asyncIterator]()
        stage = "response_body"
        for (;;) {
          const next = await nextWithDeadline(
            iterator,
            options.streamIdleTimeoutMs,
            request.signal,
          )
          if (next === cancelled) {
            pendingNext = true
            yield { type: "cancelled" }
            return
          }
          if (next === idleTimeout) {
            pendingNext = true
            attemptController.abort()
            failureEvent =
              terminalEvent === undefined
                ? {
                    type: "failure",
                    failure: modelFailureFromUnknown(undefined, {
                      provider: request.target.provider,
                      wireApi: options.wireApi,
                      stage: "response_body",
                      kind: "idle_timeout",
                      fallbackMessage: "Model stream timed out.",
                    }),
                  }
                : protocolFailureEvent(request, options)
            break
          }
          if (next.done) {
            exhausted = true
            if (terminalEvent !== undefined) {
              yield terminalEvent
              return
            }
            failureEvent = {
              type: "failure",
              failure: modelFailureFromUnknown(undefined, {
                provider: request.target.provider,
                wireApi: options.wireApi,
                stage: "response_body",
                kind: "stream_disconnected",
                fallbackMessage:
                  "Model stream ended without a terminal response.",
              }),
            }
            break
          }

          const event = next.value
          if (terminalEvent !== undefined) {
            failureEvent = protocolFailureEvent(request, options)
            break
          }
          if (
            event.type === "snapshot" ||
            event.type === "reasoning_snapshot"
          ) {
            outputObserved = true
            yield event
            continue
          }
          if (event.type === "retry") {
            throw new Error("Provider stream emitted a retry event.")
          }
          if (event.type === "cancelled") {
            if (request.signal?.aborted) {
              yield event
              return
            }
            failureEvent = {
              type: "failure",
              failure: modelFailureFromUnknown(undefined, {
                provider: request.target.provider,
                wireApi: options.wireApi,
                stage: "model_event",
                fallbackMessage:
                  "Model provider cancelled the request without caller cancellation.",
              }),
            }
            break
          }
          if (event.type === "failure") {
            failureEvent = event
            break
          }
          terminalEvent = event
        }
      } catch (cause) {
        if (request.signal?.aborted) {
          yield { type: "cancelled" }
          return
        }
        failureEvent =
          terminalEvent === undefined
            ? {
                type: "failure",
                failure: modelFailureFromUnknown(cause, {
                  provider: request.target.provider,
                  wireApi: options.wireApi,
                  stage,
                  fallbackMessage: "Model request failed.",
                }),
                cause,
              }
            : protocolFailureEvent(request, options, cause)
      }

      if (iterator !== undefined && !exhausted) {
        attemptController.abort()
        const closing = iterator.return?.()
        closeStarted = true
        if (closing !== undefined) {
          if (pendingNext) {
            void closing.catch(() => {})
          } else {
            try {
              await closing
            } catch (cause) {
              if (failureEvent === undefined) throw cause
              failureEvent = {
                ...failureEvent,
                cause:
                  failureEvent.cause === undefined
                    ? cause
                    : new AggregateError(
                        [failureEvent.cause, cause],
                        "Model attempt and cleanup both failed.",
                        { cause: failureEvent.cause },
                      ),
              }
            }
          }
        }
      }
    } finally {
      if (iterator !== undefined && !exhausted && !closeStarted) {
        attemptController.abort()
        const closing = iterator.return?.()
        if (closing !== undefined) {
          if (pendingNext) void closing.catch(() => {})
          else await closing
        }
      }
    }

    if (failureEvent === undefined) {
      throw new Error("Model attempt ended without an outcome.")
    }
    const retry = shouldRetry(
      failureEvent.failure,
      attempt,
      outputObserved,
      options,
    )
    const effectiveMaxAttempts =
      failureEvent.failure.kind === "rate_limited"
        ? Math.min(options.maxAttempts, options.rateLimitMaxAttempts)
        : options.maxAttempts
    const failure = {
      ...failureEvent.failure,
      attempt,
      maxAttempts: effectiveMaxAttempts,
      outputObserved,
      retryDecision: retry ? "retry" : "fail",
    } as const
    if (!retry) {
      yield { ...failureEvent, failure }
      return
    }
    const delayMs = retryDelay(failure, attempt, options)
    yield {
      type: "retry",
      attempt,
      nextAttempt: attempt + 1,
      maxAttempts: effectiveMaxAttempts,
      delayMs,
      failure,
      ...(failureEvent.usage === undefined
        ? {}
        : { usage: failureEvent.usage }),
    }
    previousFailure = failure
    await options.sleep(delayMs, request.signal)
  }
}

function protocolFailureEvent(
  request: ModelRequest,
  options: ResolvedModelRequestOptions,
  cause?: unknown,
): Extract<ModelStreamEvent, { readonly type: "failure" }> {
  return {
    type: "failure",
    failure: modelFailureFromUnknown(cause, {
      provider: request.target.provider,
      wireApi: options.wireApi,
      stage: "model_event",
      kind: "protocol_error",
      fallbackMessage: "Model provider returned an invalid stream sequence.",
      serverShouldRetry: false,
    }),
    ...(cause === undefined ? {} : { cause }),
  }
}

function shouldRetry(
  failure: ModelFailure,
  attempt: number,
  outputObserved: boolean,
  options: ResolvedModelRequestOptions,
): boolean {
  if (failure.serverShouldRetry === false) return false
  if (outputObserved && !options.retryAfterOutput) return false
  if (attempt >= options.maxAttempts) return false
  if (
    failure.kind === "rate_limited" &&
    attempt >= options.rateLimitMaxAttempts
  ) {
    return false
  }
  return (
    failure.kind === "connection_failed" ||
    failure.kind === "rate_limited" ||
    failure.kind === "server_error" ||
    failure.kind === "stream_disconnected"
  )
}

function retryDelay(
  failure: ModelFailure,
  attempt: number,
  options: ResolvedModelRequestOptions,
): number {
  if (
    failure.retryAfterMs !== undefined &&
    Number.isFinite(failure.retryAfterMs) &&
    failure.retryAfterMs >= 0
  ) {
    const retryAfterMs = Math.min(failure.retryAfterMs, MAX_TIMER_DELAY_MS)
    return failure.kind === "rate_limited"
      ? retryAfterMs
      : Math.min(options.maxDelayMs, retryAfterMs)
  }
  return (
    Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1)) *
    options.random()
  )
}

function validateOptions(options: ResolvedModelRequestOptions): void {
  for (const [name, value] of [
    ["maxAttempts", options.maxAttempts],
    ["rateLimitMaxAttempts", options.rateLimitMaxAttempts],
    ["streamIdleTimeoutMs", options.streamIdleTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`)
    }
  }
  if (options.streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `streamIdleTimeoutMs must be at most ${String(MAX_TIMER_DELAY_MS)}.`,
    )
  }
  if (
    !Number.isFinite(options.baseDelayMs) ||
    options.baseDelayMs < 0 ||
    options.baseDelayMs > MAX_TIMER_DELAY_MS ||
    !Number.isFinite(options.maxDelayMs) ||
    options.maxDelayMs < 0 ||
    options.maxDelayMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `Retry delays must be finite values between 0 and ${String(MAX_TIMER_DELAY_MS)} ms.`,
    )
  }
}

const idleTimeout = Symbol("idle_timeout")
const cancelled = Symbol("cancelled")

async function nextWithDeadline(
  iterator: AsyncIterator<ModelStreamEvent>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<
  IteratorResult<ModelStreamEvent> | typeof idleTimeout | typeof cancelled
> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  try {
    const waiting: Array<
      Promise<
        IteratorResult<ModelStreamEvent> | typeof idleTimeout | typeof cancelled
      >
    > = [
      iterator.next(),
      new Promise<typeof idleTimeout>((resolve) => {
        timer = setTimeout(() => resolve(idleTimeout), timeoutMs)
      }),
    ]
    if (signal !== undefined) {
      waiting.push(
        new Promise<typeof cancelled>((resolve) => {
          if (signal.aborted) {
            resolve(cancelled)
            return
          }
          const onAbort = () => resolve(cancelled)
          signal.addEventListener("abort", onAbort, { once: true })
          removeAbortListener = () =>
            signal.removeEventListener("abort", onAbort)
        }),
      )
    }
    return await Promise.race(waiting)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbortListener?.()
  }
}

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
