import type {
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelStreamEvent,
  StreamFn,
} from "./model.ts"
import { ModelStopReason as StopReason } from "./model.ts"

export type FauxRequestAssertion = (request: ModelRequest) => void

export type FauxScriptedResponse = {
  readonly snapshots?: readonly string[]
  readonly content?: readonly ModelContentBlock[]
  readonly stopReason?: ModelStopReason
  readonly error?: ModelResponse["error"]
  readonly usage?: ModelResponse["usage"]
  readonly providerRequestId?: string
  readonly metadata?: ModelResponse["metadata"]
  readonly throwBefore?: unknown
  readonly throwDuring?: unknown
  readonly endWithoutResponse?: boolean
  readonly waitForAbort?: boolean
  readonly assertRequest?: FauxRequestAssertion
}

export type FauxProvider = {
  readonly stream: StreamFn
  readonly requests: readonly ModelRequest[]
  readonly callCount: number
}

export function createFauxProvider(
  script: readonly FauxScriptedResponse[],
): FauxProvider {
  const requests: ModelRequest[] = []
  let callCount = 0

  return {
    get requests() {
      return requests.map(cloneRequest)
    },
    get callCount() {
      return callCount
    },
    stream(request) {
      const index = callCount
      callCount += 1
      requests.push(cloneRequest(request))

      const step = script[index]
      if (step === undefined) {
        throw new Error(
          `Faux provider has no scripted response for model call ${index + 1}.`,
        )
      }

      return streamScriptedResponse(step, request)
    },
  }
}

async function* streamScriptedResponse(
  step: FauxScriptedResponse,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  step.assertRequest?.(request)

  if (step.throwBefore !== undefined) throw step.throwBefore

  if (step.waitForAbort) {
    await waitForAbort(request.signal)
  }

  for (const text of step.snapshots ?? []) {
    if (request.signal?.aborted) {
      yield {
        type: "response",
        response: {
          stopReason: StopReason.Aborted,
          content: [],
        },
      }
      return
    }
    yield { type: "snapshot", text }
  }

  if (step.throwDuring !== undefined) throw step.throwDuring

  if (step.endWithoutResponse) return

  if (request.signal?.aborted) {
    yield {
      type: "response",
      response: {
        stopReason: StopReason.Aborted,
        content: [],
      },
    }
    return
  }

  yield {
    type: "response",
    response: {
      stopReason: step.stopReason ?? StopReason.EndTurn,
      content: step.content ?? [],
      ...(step.error === undefined ? {} : { error: step.error }),
      ...(step.usage === undefined ? {} : { usage: step.usage }),
      ...(step.providerRequestId === undefined
        ? {}
        : { providerRequestId: step.providerRequestId }),
      ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
    },
  }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return Promise.reject(
      new Error("Faux provider waitForAbort requires an AbortSignal."),
    )
  }
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function cloneRequest(request: ModelRequest): ModelRequest {
  return {
    system: request.system,
    messages: structuredClone(request.messages),
    tools: structuredClone(request.tools),
    provider: request.provider,
    model: request.model,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.metadata === undefined
      ? {}
      : { metadata: structuredClone(request.metadata) }),
  }
}
