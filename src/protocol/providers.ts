export type ProviderConfiguration = Readonly<{
  name: string
  wireApi:
    | "openai_responses"
    | "openai_chat_completions"
    | "anthropic_messages"
    | "gemini_generate_content"
  baseURL: string
  envKey?: string
  preset?: string
  noKey?: boolean
  enabled?: boolean
  // Explicit opt-in: request preparation may have provider-reported usage.
  requestWarmup?: boolean
  modelSelection?: "all" | "selected"
  models: readonly ConfiguredModel[]
}>

export type ApiConfiguredProvider = Readonly<{
  id: string
  configuration: ProviderConfiguration
  credential: "stored" | "environment" | "missing" | "optional"
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
  id: string
  displayName?: string
  contextWindowTokens?: number
  contextWindowScope?: "input" | "total"
  maxOutputTokens?: number
  inputModalities?: readonly ("text" | "image" | "video")[]
  efforts?: readonly string[]
  defaultEffort?: string
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
  envKey?: string
  kind?: "vendor" | "relay" | "local" | "subscription"
  noKey?: boolean
  flavor?: "generic" | "deepseek" | "gemini" | "qwen" | "mistral"
  catalogProvider?: string
  models: readonly ConfiguredModel[]
  documentationURL: string
}>
