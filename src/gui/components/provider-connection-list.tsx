import { ChevronRight } from "lucide-react"
import type { ApiConfiguredProvider } from "../../server/provider-configuration.ts"
import type { SubscriptionConnection } from "../../server/subscription-connections.ts"
import { ProviderLogo } from "./provider-logo.tsx"
import { Badge } from "./ui/badge.tsx"

export function ProviderConnectionList({
  providers,
  subscriptions,
  pending,
  onEdit,
  onSubscription,
  onEnabled,
  onMove,
}: Readonly<{
  providers: readonly ApiConfiguredProvider[]
  subscriptions: readonly SubscriptionConnection[]
  pending: boolean
  onEdit(provider: ApiConfiguredProvider): void
  onSubscription(id: string): void
  onEnabled(provider: ApiConfiguredProvider, enabled: boolean): void
  onMove(id: string, beforeId?: string): void
}>) {
  return (
    <section className="provider-connections" aria-label="Configured providers">
      {subscriptions
        .filter((entry) => entry.available)
        .map((entry) => (
          <div className="provider-connection" key={entry.id}>
            <button
              type="button"
              className="provider-connection-main"
              onClick={() => onSubscription(entry.id)}
            >
              <ProviderLogo preset={entry.id === "codex" ? "openai" : "xai"} />
              <span className="provider-connection-info">
                <strong>{entry.name}</strong>
                <span>Subscription · signed in</span>
              </span>
            </button>
            <Badge variant="secondary">Signed in</Badge>
            <ChevronRight size={14} className="provider-connection-chevron" />
          </div>
        ))}
      {providers.map((provider, index) => {
        const config = provider.configuration
        const all =
          config.modelSelection === "all" ||
          (config.modelSelection !== "selected" && !config.models.length)
        const count = all
          ? (provider.catalog?.models.length ?? 0)
          : config.models.length
        const error =
          provider.connection?.state === "error"
            ? provider.connection.message
            : undefined
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: Drop target; keyboard reordering is on the logo button.
          <div
            className="provider-connection"
            key={provider.id}
            data-disabled={config.enabled === false}
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes(
                  "application/yakitori-provider",
                )
              )
                event.preventDefault()
            }}
            onDrop={(event) => {
              const id = event.dataTransfer.getData(
                "application/yakitori-provider",
              )
              if (id && !pending) {
                event.preventDefault()
                onMove(id, provider.id)
              }
            }}
          >
            <button
              type="button"
              className="provider-move"
              aria-label={`Move ${config.name}`}
              title="Drag to reorder · Alt + Up/Down"
              draggable={!pending}
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  "application/yakitori-provider",
                  provider.id,
                )
                event.dataTransfer.effectAllowed = "move"
              }}
              onKeyDown={(event) => {
                if (!event.altKey || pending) return
                if (event.key === "ArrowUp" && index > 0) {
                  event.preventDefault()
                  onMove(provider.id, providers[index - 1]?.id)
                }
                if (event.key === "ArrowDown" && index < providers.length - 1) {
                  event.preventDefault()
                  onMove(provider.id, providers[index + 2]?.id)
                }
              }}
              onClick={() => onEdit(provider)}
            >
              <ProviderLogo preset={config.preset} />
            </button>
            <button
              type="button"
              className="provider-connection-main"
              onClick={() => onEdit(provider)}
            >
              <span className="provider-connection-info">
                <strong>{config.name}</strong>
                <span>
                  {new URL(config.baseURL).host} · {count}{" "}
                  {count === 1 ? "model" : "models"}
                </span>
              </span>
            </button>
            <Badge
              variant="secondary"
              className="provider-credential"
              data-missing={provider.credential === "missing" || !!error}
              title={error ?? provider.connection?.message}
            >
              <span className="provider-status-dot" />
              {error
                ? "Needs attention"
                : provider.connection?.state === "ready"
                  ? "Connected"
                  : provider.credential === "stored"
                    ? "Key saved"
                    : provider.credential === "environment"
                      ? "Environment key"
                      : provider.credential === "optional"
                        ? "No key needed"
                        : "Key required"}
            </Badge>
            <button
              type="button"
              role="switch"
              className="provider-switch"
              aria-label={`Enable ${config.name}`}
              aria-checked={config.enabled !== false}
              disabled={pending}
              onClick={() => onEnabled(provider, config.enabled === false)}
            >
              <span />
            </button>
            <ChevronRight size={14} className="provider-connection-chevron" />
          </div>
        )
      })}
    </section>
  )
}
