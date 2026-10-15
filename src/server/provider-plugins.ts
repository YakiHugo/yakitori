import type { ModelProvider } from "../runtime/model-provider.ts"
import type { ProviderRegistry } from "../runtime/provider-registry.ts"

// A host-supplied factory, without package loading or ownership of the agent loop.
// A factory cleans up partial allocations if it throws before returning.
export type ModelProviderPlugin = Readonly<{
  id: string
  createProviders():
    | Readonly<Record<string, ModelProvider>>
    | Promise<Readonly<Record<string, ModelProvider>>>
}>

export async function registerProviderPlugins(
  registry: ProviderRegistry,
  plugins: readonly ModelProviderPlugin[],
): Promise<void> {
  const ids = new Set<string>()
  for (const plugin of plugins) {
    if (plugin.id.trim() === "" || ids.has(plugin.id))
      throw new Error(`Provider plugin id ${plugin.id} is empty or duplicated.`)
    ids.add(plugin.id)
  }
  for (const plugin of plugins) {
    const providers = await plugin.createProviders()
    try {
      registry.register(`plugin:${plugin.id}`, providers)
    } catch (cause) {
      const cleanup = await Promise.allSettled(
        [...new Set(Object.values(providers))].map((provider) =>
          Promise.resolve().then(() => provider.close?.()),
        ),
      )
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )
      if (errors.length > 0)
        throw new AggregateError(
          [cause, ...errors],
          "Provider plugin registration and cleanup failed.",
        )
      throw cause
    }
  }
}
