import { createHash } from "node:crypto"
import type {
  ModelRequest,
  ModelTarget,
  ModelWireApi,
  StreamFn,
} from "./model.ts"
import type { ModelsManager } from "./models-manager.ts"
import { createStaticModelsManager } from "./models-manager.ts"
import {
  createModelRequestStream,
  type ModelRequestOptions,
  type ModelRequestPolicy,
} from "./model-request.ts"

export type ModelProviderCapabilities = Readonly<{
  remoteCompaction: false | "codex_remote" | "responses_compact"
  // Opt in only for an endpoint whose native PDF support is known.
  nativePdf?: boolean
}>

export type ModelProviderInfo = Readonly<{
  id: string
  wireApi: ModelWireApi
  capabilities: ModelProviderCapabilities
  retry?: Omit<ModelRequestOptions, "wireApi" | "streamIdleTimeoutMs">
  streamIdleTimeoutMs?: number
}>

export type ModelClientSession = {
  // Captured with this Turn's transport and capabilities, including after reload.
  readonly models: ModelsManager
  readonly wireApi?: ModelWireApi
  readonly remoteCompaction?: ModelProviderCapabilities["remoteCompaction"]
  readonly nativePdf?: boolean
  readonly stream: StreamFn
  // Optional, non-generating request preparation. Caller accounts its usage.
  readonly warmup?: StreamFn
  close(): void | Promise<void>
}

// Session-scoped transport owner. Each startTurn call captures a provider and
// creates fresh Turn-scoped connection/retry state.
export type ModelClient = {
  hasProvider(provider: string): boolean
  models(provider: string): ModelsManager
  startTurn(provider: string, policy?: ModelRequestPolicy): ModelClientSession
  close(): void | Promise<void>
}

export type ModelProvider = {
  readonly info: ModelProviderInfo
  readonly models: ModelsManager
  startTurn(policy?: ModelRequestPolicy): ModelClientSession
}

export type ModelAttemptContext = NonNullable<ModelRequest["attempt"]>

// Stable opaque identity for continuation blobs valid for one endpoint and
// credential or authenticated account. Only the domain-separated digest enters
// durable metadata; callers capture owner identity with the matching credential.
export function createProviderContinuationScope(
  provider: string,
  baseURL: string,
  ownerIdentity: string,
): string {
  return `${provider}:${createHash("sha256")
    .update("yakitori-provider-continuation-v1\0")
    .update(provider)
    .update("\0")
    .update(baseURL)
    .update("\0")
    .update(ownerIdentity)
    .digest("hex")}`
}

export function createModelProvider(
  input: Readonly<{
    info: ModelProviderInfo
    models?: ModelsManager
    continuationScope?: string
  }> &
    (
      | Readonly<{ stream: StreamFn }>
      | Readonly<{ createTurnStream: () => StreamFn }>
      | Readonly<{
          createTurnTransport: () => Pick<
            ModelClientSession,
            "stream" | "warmup" | "close"
          >
        }>
      | Readonly<{
          createAttemptStream: (attempt: ModelAttemptContext) => StreamFn
        }>
    ),
): ModelProvider {
  const models = input.models ?? createStaticModelsManager(input.info.id)
  // An opaque provider item must never cross backend/configuration identity.
  // A provider instance is the narrowest identity available for injected
  // transports. Production API-key providers pass a stable configuration
  // scope; providers with a stable account identity may replace it per request.
  const continuationScope =
    input.continuationScope ?? globalThis.crypto.randomUUID()
  if (models.provider !== input.info.id) {
    throw new Error(
      `Provider ${input.info.id} cannot use models manager for ${models.provider}.`,
    )
  }
  return {
    info: input.info,
    models,
    startTurn(policy) {
      const transport =
        "createTurnTransport" in input ? input.createTurnTransport() : undefined
      const warmupStream = transport?.warmup
      const providerStream: StreamFn =
        transport !== undefined
          ? transport.stream
          : "createTurnStream" in input
            ? input.createTurnStream()
            : "createAttemptStream" in input
              ? (request) =>
                  input.createAttemptStream(
                    request.attempt ?? { number: 1, maxAttempts: 1 },
                  )(request)
              : "stream" in input
                ? input.stream
                : (() => {
                    throw new Error("Missing Turn transport.")
                  })()
      // Text deltas remain provisional. A completed output item commits
      // history and may start tools, so retries must rebuild from that history.
      const stream = createModelRequestStream(providerStream, {
        wireApi: input.info.wireApi,
        ...(input.info.streamIdleTimeoutMs === undefined
          ? {}
          : { streamIdleTimeoutMs: input.info.streamIdleTimeoutMs }),
        ...input.info.retry,
        ...policy,
      })
      // Codex remote v2 permits at most two stream retries, including
      // failures after provisional output. No history is installed yet.
      const remoteStream = createModelRequestStream(providerStream, {
        wireApi: input.info.wireApi,
        ...(input.info.streamIdleTimeoutMs === undefined
          ? {}
          : { streamIdleTimeoutMs: input.info.streamIdleTimeoutMs }),
        ...input.info.retry,
        ...policy,
        maxAttempts: Math.min(
          policy?.maxAttempts ?? input.info.retry?.maxAttempts ?? 4,
          3,
        ),
        rateLimitMaxAttempts: Math.min(
          policy?.rateLimitMaxAttempts ??
            input.info.retry?.rateLimitMaxAttempts ??
            2,
          3,
        ),
      })
      return {
        models,
        wireApi: input.info.wireApi,
        remoteCompaction: input.info.capabilities.remoteCompaction,
        nativePdf: input.info.capabilities.nativePdf === true,
        stream(request) {
          requireTargetProvider(input.info.id, request.target)
          if (
            (request.compaction === "codex_remote" ||
              request.compaction === "responses_compact") &&
            input.info.capabilities.remoteCompaction !== request.compaction
          ) {
            throw new Error(
              `Provider ${input.info.id} does not support remote compaction.`,
            )
          }
          return (
            request.compaction === "codex_remote" ? remoteStream : stream
          )({
            ...request,
            continuationScope,
          })
        },
        ...(warmupStream === undefined
          ? {}
          : {
              warmup: ((request) => {
                requireTargetProvider(input.info.id, request.target)
                return warmupStream({ ...request, continuationScope })
              }) as StreamFn,
            }),
        close() {
          return transport?.close()
        },
      }
    },
  }
}

export function createInjectedModelProvider(
  id: string,
  stream: StreamFn,
): ModelProvider {
  return createModelProvider({
    info: {
      id,
      wireApi: "unknown",
      capabilities: { remoteCompaction: false },
      // An injected stream owns its own retry behavior unless the injector
      // supplies a real ModelProvider with an explicit policy.
      retry: { maxAttempts: 1 },
    },
    stream,
  })
}

function requireTargetProvider(provider: string, target: ModelTarget): void {
  if (target.provider !== provider) {
    throw new Error(
      `Provider client ${provider} cannot start target ${target.provider}/${target.model}.`,
    )
  }
}
