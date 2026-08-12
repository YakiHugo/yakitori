import type { StreamFn } from "./model.ts"

export type ProviderRegistry = {
  readonly providers: readonly string[]
  readonly stream: StreamFn
}

export function createProviderRegistry(
  providers: Readonly<Record<string, StreamFn>>,
): ProviderRegistry {
  const entries = Object.entries(providers)
  return {
    providers: entries.map(([provider]) => provider),
    stream(request) {
      const stream = providers[request.target.provider]
      if (!stream) {
        throw new Error(
          `Provider ${request.target.provider} is not registered. Available providers: ${entries.map(([provider]) => provider).join(", ") || "none"}.`,
        )
      }
      return stream(request)
    },
  }
}
