import type { StreamFn } from "../runtime/model.ts"
import type { ModelProvider } from "../runtime/model-provider.ts"
import type { ProviderRegistry } from "../runtime/provider-registry.ts"

// Account owners publish disjoint identities. A collision is an error, never an
// instruction to shadow another account according to application merge order.
export function createAccountRuntime(registry: ProviderRegistry) {
  const registration = registry.register("accounts", {})
  const sources = new Map<
    string,
    Readonly<Record<string, ModelProvider | StreamFn>>
  >()
  return {
    publish(
      owner: string,
      providers: Readonly<Record<string, ModelProvider | StreamFn>>,
    ) {
      const next = new Map(sources)
      next.set(owner, providers)
      const combined: Record<string, ModelProvider | StreamFn> = {}
      for (const entries of next.values()) {
        for (const [id, provider] of Object.entries(entries)) {
          if (Object.hasOwn(combined, id))
            throw new Error(`Account ${id} has more than one owner.`)
          combined[id] = provider
        }
      }
      const retiring = registration.replace(combined)
      sources.set(owner, providers)
      return retiring
    },
  }
}
