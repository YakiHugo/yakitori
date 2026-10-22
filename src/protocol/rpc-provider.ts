import type {
  ProviderConfigurationResponse,
  ProviderWriteInput,
} from "./providers.ts"
export type ProviderRpcParams = {
  "provider/models/read": Readonly<{ provider: string }>
  "provider/models/write": Readonly<{
    provider: string
    settings: import("./providers.ts").ProviderModelSettings
    version: string
  }>
  "provider/models/refresh": Readonly<{ provider: string }>
  "provider/configuration/read": Record<string, never>
  "provider/configuration/write": ProviderWriteInput
  "provider/configuration/delete": Readonly<{ id: string }>
  "provider/configuration/test": ProviderWriteInput
  "provider/configuration/models": ProviderWriteInput
  "provider/subscription/login": Readonly<{
    id: string
    reauthenticate?: boolean
  }>
  "provider/subscription/cancel": Readonly<{ id: string }>
  "provider/subscription/import": Readonly<{ id: string; text?: string }>
  "provider/configuration/refresh": Record<string, never>
  "provider/configuration/move": Readonly<{ id: string; beforeId?: string }>
  "provider/configuration/restore": Readonly<{ undoId: string }>
}

export type ProviderRpcResponses = {
  "provider/models/read": import("./providers.ts").ModelCatalogResponse
  "provider/models/write": import("./providers.ts").ModelCatalogResponse
  "provider/models/refresh": import("./providers.ts").ModelCatalogResponse
  "provider/configuration/read": ProviderConfigurationResponse
  "provider/configuration/write": ProviderConfigurationResponse
  "provider/configuration/delete": ProviderConfigurationResponse
  "provider/configuration/test": Readonly<{ ok: true }>
  "provider/configuration/models": readonly import("./providers.ts").ConfiguredModel[]
  "provider/subscription/login": readonly import("./providers.ts").SubscriptionConnection[]
  "provider/subscription/cancel": readonly import("./providers.ts").SubscriptionConnection[]
  "provider/subscription/import": readonly import("./providers.ts").SubscriptionConnection[]
  "provider/configuration/refresh": ProviderConfigurationResponse
  "provider/configuration/move": ProviderConfigurationResponse
  "provider/configuration/restore": ProviderConfigurationResponse
}
