import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import type { ApiConfiguredProvider } from "../../protocol/providers.ts"
import { useAppStore } from "../store/app-store.ts"
import { ProviderLogo } from "./provider-logo.tsx"
import { Badge } from "./ui/badge.tsx"

export function ProviderConnectionList({
  providers,
  children,
  pending,
  onOpen,
  onEnabled,
  onMove,
}: Readonly<{
  children?: ReactNode
  providers: readonly ApiConfiguredProvider[]
  pending: boolean
  onOpen(provider: ApiConfiguredProvider): void
  onEnabled(provider: ApiConfiguredProvider, enabled: boolean): void
  onMove(id: string, beforeId?: string): void
}>) {
  const accounts = useAppStore((state) => state.accounts)
  return (
    <section className="provider-connections" aria-label="Configured providers">
      {children}
      {providers.map((provider, index) => {
        const config = provider.configuration
        const count =
          accounts.find((account) => account.name === provider.id)?.models
            .length ??
          new Set(
            [...(provider.catalog?.models ?? []), ...config.models]
              .filter((model) => model.visible !== false)
              .map((model) => model.id),
          ).size
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
              onClick={() => onOpen(provider)}
            >
              <ProviderLogo preset={config.preset} />
            </button>
            <button
              type="button"
              className="provider-connection-main"
              onClick={() => onOpen(provider)}
            >
              <span className="provider-connection-info">
                <strong>{config.name}</strong>
                <span>
                  {new URL(config.baseURL).host} · {count}{" "}
                  {count === 1 ? "model" : "models"}
                </span>
              </span>
            </button>
            {error || provider.credential === "missing" ? (
              <Badge
                variant="secondary"
                className="provider-credential"
                data-missing="true"
                title={error}
              >
                {error ? "Needs attention" : "Key required"}
              </Badge>
            ) : null}
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
