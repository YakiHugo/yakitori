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
  remoteCompaction: boolean
}>

export type ModelProviderInfo = Readonly<{
  id: string
  wireApi: ModelWireApi
  capabilities: ModelProviderCapabilities
  retry?: Omit<ModelRequestOptions, "wireApi" | "streamIdleTimeoutMs">
  streamIdleTimeoutMs?: number
}>

export type ModelClientSession = {
  readonly remoteCompaction?: boolean
  readonly stream: StreamFn
  close(): void | Promise<void>
}

// Session-scoped transport owner. It retains provider clients while every
// startTurn call creates a fresh Turn-scoped connection/retry state owner.
export type ModelClient = {
  hasProvider(provider: string): boolean
  models(provider: string): ModelsManager
  startTurn(provider: string, policy?: ModelRequestPolicy): ModelClientSession
  close(): void | Promise<void>
}

export type ModelProviderClient = {
  startTurn(policy?: ModelRequestPolicy): ModelClientSession
  close(): void | Promise<void>
}

export type ModelProvider = {
  readonly info: ModelProviderInfo
  readonly models: ModelsManager
  createClient(): ModelProviderClient
}

export type ModelAttemptContext = NonNullable<ModelRequest["attempt"]>

// Stable opaque identity for continuation blobs that are only valid for one
// provider endpoint and credential. The high-entropy credential is never
// stored; only its domain-separated digest enters durable metadata.
export function createProviderContinuationScope(
  provider: string,
  baseURL: string,
  credential: string,
): string {
  return `${provider}:${createHash("sha256")
    .update("yakitori-provider-continuation-v1\0")
    .update(provider)
    .update("\0")
    .update(baseURL)
    .update("\0")
    .update(credential)
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
    createClient() {
      return {
        startTurn(policy) {
          const providerStream: StreamFn =
            "createTurnStream" in input
              ? input.createTurnStream()
              : "createAttemptStream" in input
                ? (request) =>
                    input.createAttemptStream(
                      request.attempt ?? { number: 1, maxAttempts: 1 },
                    )(request)
                : input.stream
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
            retryAfterOutput: true,
          })
          return {
            remoteCompaction: input.info.capabilities.remoteCompaction,
            stream(request) {
              requireTargetProvider(input.info.id, request.target)
              if (
                request.compaction === "remote_v2" &&
                !input.info.capabilities.remoteCompaction
              ) {
                throw new Error(
                  `Provider ${input.info.id} does not support remote compaction.`,
                )
              }
              return (
                request.compaction === "remote_v2" ? remoteStream : stream
              )({
                ...request,
                continuationScope,
              })
            },
            close() {},
          }
        },
        close() {},
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
