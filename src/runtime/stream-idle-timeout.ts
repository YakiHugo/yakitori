import {
  ModelStopReason,
  type ModelRequest,
  type ModelStreamEvent,
  type StreamFn,
} from "./model.ts"

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

export function withStreamIdleTimeout(
  stream: StreamFn,
  timeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
): StreamFn {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Stream idle timeout must be a positive number.")
  }
  return (request) => streamWithIdleTimeout(stream, request, timeoutMs)
}

async function* streamWithIdleTimeout(
  stream: StreamFn,
  request: ModelRequest,
  timeoutMs: number,
): AsyncGenerator<ModelStreamEvent> {
  const timeoutController = new AbortController()
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeoutController.signal])
    : timeoutController.signal
  const iterator = stream({ ...request, signal })[Symbol.asyncIterator]()
  let timedOut = false
  let completed = false
  try {
    for (;;) {
      const next = await nextWithTimeout(iterator, timeoutMs)
      if (next === idleTimeout) {
        timedOut = true
        timeoutController.abort()
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.Error,
            content: [],
            error: {
              code: "stream_idle_timeout",
              message: `Model stream produced no event for ${timeoutMs} ms.`,
              details: { idleTimeoutMs: timeoutMs },
            },
          },
        }
        return
      }
      if (next.done) {
        completed = true
        return
      }
      yield next.value
    }
  } finally {
    if (!completed) {
      timeoutController.abort()
      const closing = iterator.return?.()
      if (closing !== undefined) {
        if (timedOut) void closing.catch(() => {})
        else await closing
      }
    }
  }
}

const idleTimeout = Symbol("idle_timeout")

async function nextWithTimeout(
  iterator: AsyncIterator<ModelStreamEvent>,
  timeoutMs: number,
): Promise<IteratorResult<ModelStreamEvent> | typeof idleTimeout> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<typeof idleTimeout>((resolve) => {
        timer = setTimeout(() => resolve(idleTimeout), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
