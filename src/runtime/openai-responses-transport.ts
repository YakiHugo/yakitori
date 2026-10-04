import OpenAI from "openai"
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses"
import { ResponsesWS } from "openai/resources/responses/ws"

// Implementation safety boundary, not an API quota: retain at most one unused
// prefix for a short tool-execution gap, never an idle/background connection.
const WARMUP_LIFETIME_MS = 15_000

/** A single Turn owns this socket. Credentials and configuration cannot rotate
 * underneath it. Reconnection never replays a sent request: runtime retry policy
 * owns that decision and falls back to the complete HTTP request. */
export function createOpenAIResponsesTransport(client: OpenAI) {
  let socket: ResponsesWS | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let stopReading: (() => void) | undefined
  let used = false
  let closed = false
  let epoch = 0
  let ready:
    | {
        id: string
        settings: string
        input: string[]
        scope: string | undefined
      }
    | undefined

  const discard = () => {
    epoch += 1
    ready = undefined
    clearTimeout(expiry)
    expiry = undefined
    const owned = socket
    socket = undefined
    stopReading?.()
    stopReading = undefined
    owned?.close()
  }

  async function* exchange(
    owned: ResponsesWS,
    body: ResponseCreateParamsStreaming,
    signal: AbortSignal | undefined,
    warmup: boolean,
    previous?: { id: string; input: string[] },
    scope?: string,
  ): AsyncGenerator<ResponseStreamEvent> {
    const generation = epoch
    const events = owned[Symbol.asyncIterator]()
    stopReading = () => {
      void events.return?.()
    }
    const abort = () => discard()
    signal?.addEventListener("abort", abort, { once: true })
    let completed = false
    let outputObserved = false
    try {
      if (signal?.aborted) return
      const { stream: _stream, ...payload } = body
      // generate:false is documented but not yet in the installed SDK's type.
      owned.sendRaw(
        JSON.stringify({
          ...payload,
          type: "response.create",
          ...(warmup ? { generate: false } : {}),
          ...(previous === undefined
            ? {}
            : {
                previous_response_id: previous.id,
                input: Array.isArray(body.input)
                  ? body.input.slice(previous.input.length)
                  : body.input,
              }),
        }),
      )
      for await (const event of events) {
        if (event.type === "error") {
          // Explicit cache miss rejects continuation before generation. Only
          // this response permits local replay; ambiguous disconnects belong
          // to the runtime retry boundary, never an automatic second request.
          if (
            !warmup &&
            !outputObserved &&
            event.error.error?.code === "previous_response_not_found"
          ) {
            discard()
            const fallback = await client.responses.create(
              body,
              signal === undefined ? undefined : { signal },
            )
            if (fallback === undefined)
              throw new Error("OpenAI returned no response stream.")
            yield* fallback
            completed = true
            return
          }
          throw event.error
        }
        if (event.type !== "message") continue
        const message = event.message
        outputObserved ||=
          message.type === "response.output_item.added" ||
          message.type === "response.output_item.done" ||
          message.type.endsWith(".delta")
        if (
          warmup &&
          (message.type === "response.output_item.added" ||
            message.type === "response.output_item.done" ||
            message.type.endsWith(".delta"))
        ) {
          throw new Error("Non-generating warmup unexpectedly produced output.")
        }
        if (message.type === "response.completed") {
          if (
            warmup &&
            message.response.output.length === 0 &&
            generation === epoch &&
            !signal?.aborted
          ) {
            const { input, ...settings } = body
            ready = {
              id: message.response.id,
              settings: JSON.stringify(settings),
              input: Array.isArray(input)
                ? input.map((item) => JSON.stringify(item))
                : [],
              scope,
            }
          }
          completed = true
          yield message
          return
        }
        yield message
        if (
          message.type === "response.failed" ||
          message.type === "response.incomplete" ||
          message.type === "error"
        )
          return
      }
      if (!signal?.aborted)
        throw new OpenAI.APIConnectionError({
          message: "OpenAI WebSocket closed before its terminal response.",
        })
    } finally {
      signal?.removeEventListener("abort", abort)
      stopReading = undefined
      await events.return?.()
      if (!warmup || !completed) discard()
    }
  }

  return {
    warmup(
      body: ResponseCreateParamsStreaming,
      signal?: AbortSignal,
      scope?: string,
    ) {
      if (closed || used || signal?.aborted || !Array.isArray(body.input))
        return undefined
      used = true
      // No SDK reconnect/replay; any recovery uses a fresh full-context request.
      socket = new ResponsesWS(client, {
        reconnect: null,
        handshakeTimeout: WARMUP_LIFETIME_MS,
      })
      socket.on("error", () => {
        if (stopReading === undefined) discard()
      })
      expiry = setTimeout(discard, WARMUP_LIFETIME_MS)
      expiry.unref?.()
      return exchange(socket, body, signal, true, undefined, scope)
    },
    take(
      body: ResponseCreateParamsStreaming,
      signal?: AbortSignal,
      scope?: string,
    ) {
      const previous = ready
      const owned = socket
      const { input, ...settings } = body
      if (
        closed ||
        signal?.aborted ||
        previous === undefined ||
        owned === undefined ||
        owned.socket.readyState !== 1 ||
        previous.scope !== scope ||
        JSON.stringify(settings) !== previous.settings ||
        !Array.isArray(input) ||
        input.length < previous.input.length ||
        previous.input.some(
          (item, index) => JSON.stringify(input[index]) !== item,
        )
      ) {
        discard()
        return undefined
      }
      ready = undefined
      clearTimeout(expiry)
      expiry = undefined
      return exchange(owned, body, signal, false, previous, scope)
    },
    close() {
      closed = true
      discard()
    },
  }
}
