import { Plus, Search } from "lucide-react"
import { useState } from "react"
import type { ProviderPreset } from "../../runtime/provider-presets.ts"
import type { SubscriptionConnection } from "../../server/subscription-connections.ts"
import type { ApiConfiguredProvider } from "../../server/provider-configuration.ts"
import { ProviderLogo } from "./provider-logo.tsx"
import { Button } from "./ui/button.tsx"
import { Input } from "./ui/field.tsx"

export function ProviderCatalog({
  presets,
  providers,
  subscriptions,
  onPick,
  onSubscription,
  onClose,
  onImport,
}: Readonly<{
  presets: readonly ProviderPreset[]
  providers: readonly ApiConfiguredProvider[]
  subscriptions: readonly SubscriptionConnection[]
  onPick(preset?: ProviderPreset): void
  onSubscription(subscription: SubscriptionConnection): void
  onClose?(): void
  onImport(): void
}>) {
  const [query, setQuery] = useState("")
  const match = (name: string) =>
    name.toLowerCase().includes(query.trim().toLowerCase())
  const groups = [
    ["subscription", "Subscriptions", "Sign in or use a Coding Plan."],
    ["vendor", "Vendors", "Connect directly with an API key."],
    ["relay", "Relays", "Access multiple providers with one key."],
    ["local", "On this machine", "Connect a local model server."],
  ] as const
  let count = 0
  return (
    <section className="provider-catalog" aria-label="Add provider">
      <div className="provider-catalog-toolbar">
        <h2>Add provider</h2>
        <div className="provider-search">
          <Search size={16} aria-hidden="true" />
          <Input
            type="search"
            aria-label="Find a provider"
            placeholder="Find a provider…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing)
                return
              event.preventDefault()
              event.stopPropagation()
              if (query) setQuery("")
              else onClose?.()
            }}
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onImport}>
          Import…
        </Button>
        {onClose ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>
      {groups.map(([kind, name, hint]) => {
        const entries = presets.filter(
          (preset) =>
            (preset.kind ?? "vendor") === kind &&
            match(`${preset.name} ${preset.id} ${preset.baseURL}`),
        )
        const logins =
          kind === "subscription"
            ? subscriptions.filter((entry) => match(entry.name))
            : []
        count += entries.length + logins.length
        if (!entries.length && !logins.length) return null
        return (
          <section
            key={kind}
            className="provider-catalog-group"
            aria-label={name}
          >
            <div className="provider-catalog-label">
              <h3>{name}</h3>
              <p>{hint}</p>
            </div>
            <div className="provider-presets">
              {logins.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  onClick={() => onSubscription(entry)}
                >
                  <ProviderLogo
                    preset={entry.id === "codex" ? "openai" : "xai"}
                  />
                  <span>{entry.name}</span>
                  {entry.available ? (
                    <span className="provider-added" title="Account connected">
                      <span className="provider-status-dot" />
                    </span>
                  ) : null}
                </button>
              ))}
              {entries.map((preset) => {
                const added = providers.filter(
                  (entry) => entry.configuration.preset === preset.id,
                ).length
                return (
                  <button
                    type="button"
                    key={preset.id}
                    onClick={() => onPick(preset)}
                  >
                    <ProviderLogo preset={preset.id} />
                    <span>{preset.name}</span>
                    {added ? (
                      <span
                        className="provider-added"
                        title="Already configured"
                      >
                        <span className="provider-status-dot" />
                        {added > 1 ? added : null}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
      {!count ? (
        <p className="provider-catalog-empty">
          No provider matches “{query}”. Connect it as a custom provider.
        </p>
      ) : null}
      <button
        type="button"
        className="provider-custom-row"
        aria-labelledby="provider-custom-name"
        aria-describedby="provider-custom-description"
        onClick={() => onPick()}
      >
        <span className="provider-custom-icon">
          <Plus size={18} />
        </span>
        <span className="provider-custom-info">
          <strong id="provider-custom-name">Custom provider</strong>
          <span id="provider-custom-description">
            Connect any OpenAI or Anthropic compatible API.
          </span>
        </span>
      </button>
    </section>
  )
}
