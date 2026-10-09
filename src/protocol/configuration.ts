import type { ApiUserModelPreference } from "./application.ts"
import type { ProviderConfiguration } from "./providers.ts"

// Native engine settings remain opaque to clients; application settings have
// their shared wire types without exposing native services or validators.
export type ApplicationConfiguration = Readonly<{
  modelProviders?: Readonly<
    Record<string, ProviderConfiguration & { credentialRef?: string }>
  >
  preference?: ApiUserModelPreference
  baseInstructions?: string
  modelContextWindowTokens?: number
  modelAutoCompactTokenLimit?: number
  projectRootMarkers?: readonly string[]
  projectInstructionFilenames?: readonly string[]
  [key: string]: unknown
}>

export type ConfigLayerSource = "user" | "project"

export type ConfigLayerSnapshot = Readonly<{
  source: ConfigLayerSource
  path: string
  version: string
  disabledReason?: string
}>

export type ConfigOrigin = Readonly<{
  source: ConfigLayerSource
  path: string
  version: string
}>

// Parsed configuration remains server-owned; clients consume the effective JSON
// configuration and provenance without depending on native runtime settings.
export type ConfigurationSnapshot<Configuration = ApplicationConfiguration> =
  Readonly<{
    configuration: Configuration
    // JSON has no bigint representation. TOML integers outside its safe range
    // are exposed as exact base-10 strings on the RPC wire.
    effective: Readonly<Record<string, unknown>>
    origins: Readonly<Record<string, ConfigOrigin>>
    layers: readonly ConfigLayerSnapshot[]
  }>
