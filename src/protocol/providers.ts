export type ProviderConfiguration = Readonly<{
  name: string
  wireApi:
    | "openai_responses"
    | "openai_chat_completions"
    | "anthropic_messages"
    | "gemini_generate_content"
    | "gemini_interactions"
  baseURL: string
  // Stable service identity; vendor models share this namespace across accounts.
  // `preset` below records only the creation template.
  service?: string
  // Selects exactly one credential source. Keys never fall back to another source.
  authentication?: "stored" | "environment" | "none" | "codex_cli" | "grok_cli"
  credentialPath?: string
  credentialOwner?: string
  envKey?: string
  preset?: string
  enabled?: boolean
  // Explicit opt-in: request preparation may have provider-reported usage.
  requestWarmup?: boolean
  models: readonly ConfiguredModel[]
}>

export type ApiConfiguredProvider = Readonly<{
  id: string
  configuration: ProviderConfiguration
  credential: "stored" | "environment" | "external" | "missing" | "optional"
  catalog?: Readonly<{
    models: readonly ConfiguredModel[]
    fetchedAt?: number
    error?: string
  }>
  connection?: Readonly<{
    state: "ready" | "error"
    checkedAt: number
    message?: string
  }>
}>

export type SubscriptionConnection = Readonly<{
  id: "codex" | "grok"
  name: string
  available: boolean
  login?: Readonly<{
    state: "running" | "succeeded" | "failed"
    url?: string
    message?: string
  }>
}>

export type ProviderConfigurationResponse = Readonly<{
  providers: readonly ApiConfiguredProvider[]
  presets: readonly ProviderPreset[]
  subscriptions: readonly SubscriptionConnection[]
  undoId?: string
}>

export type ProviderWriteInput = Readonly<{
  id?: string
  configuration: ProviderConfiguration
  apiKey?: string
}>

export type ConfiguredModel = Readonly<{
  // Explicit equivalence, never inferred from a display name or an alias.
  identity?: Readonly<{ namespace: string; model: string }>
  // Missing means the catalog did not identify the model's output purpose.
  kind?: "chat" | "image" | "video" | "other"
  defaultVisible?: boolean
  visible?: boolean
  id: string
  displayName?: string
  contextWindowTokens?: number
  contextWindowScope?: "input" | "total"
  maxContextWindowTokens?: number
  maxOutputTokens?: number
  inputModalities?: readonly ("text" | "image" | "video")[]
  efforts?: readonly string[]
  defaultEffort?: string
  speeds?: readonly string[]
  imageDetailModes?: readonly ("high" | "original")[]
  instructionProfileId?: string
  pricing?: Readonly<{
    inputPerMillion: number
    outputPerMillion: number
    cacheReadPerMillion?: number
    cacheWritePerMillion?: number
  }>
}>

export type ProviderPreset = Readonly<{
  id: string
  name: string
  baseURL: string
  wireApi:
    | "openai_responses"
    | "openai_chat_completions"
    | "anthropic_messages"
    | "gemini_generate_content"
    | "gemini_interactions"
  envKey?: string
  kind?: "vendor" | "relay" | "local" | "subscription"
  noKey?: boolean
  flavor?: "generic" | "deepseek" | "gemini" | "qwen" | "mistral"
  catalogProvider?: string
  models: readonly ConfiguredModel[]
  documentationURL: string
}>

// User overrides are separate from the provider's discovered catalog.
export type ModelSettings = Omit<
  ConfiguredModel,
  "id" | "defaultVisible" | "kind" | "identity"
>
export type ProviderModelSettings = Readonly<Record<string, ModelSettings>>
export type ModelSettingsConfiguration = Readonly<
  Record<string, ProviderModelSettings>
>
export type ModelCatalogResponse = Readonly<{
  provider: string
  models: readonly (ConfiguredModel & { visible: boolean })[]
  settings: ProviderModelSettings
  version: string
  fetchedAt?: number
  error?: string
}>
