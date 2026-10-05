import { supportsOpenAIRequestWarmup } from "../shared/request-warmup-policy.ts"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"
import { requireInstructionProfileId } from "../runtime/model-catalog.ts"
import { ConfigurationError } from "./config-errors.ts"

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

export type StoredProviderConfiguration = ProviderConfiguration &
  Readonly<{
    credentialRef?: string
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

export function requireProviderId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_-]*$/.test(value) ||
    ["__proto__", "constructor", "prototype", "faux", "codex", "kimi"].includes(
      value,
    )
  ) {
    throw new ConfigurationError(
      "Provider id must start with a lowercase letter and contain only lowercase letters, numbers, underscores or hyphens. faux, codex and kimi are reserved.",
    )
  }
  return value
}

export function requireProviderConfiguration(
  value: unknown,
): ProviderConfiguration {
  const record = requireRecord(value, "Provider configuration")
  const name = requireString(record.name, "name")
  const baseURL = requireString(record.baseURL, "baseURL")
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new ConfigurationError(
      "baseURL must be an absolute HTTP or HTTPS URL.",
    )
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ConfigurationError(
      "baseURL must be an HTTP or HTTPS URL without credentials, a query or a fragment.",
    )
  }
  const wireApi = record.wireApi
  if (
    wireApi !== "openai_responses" &&
    wireApi !== "openai_chat_completions" &&
    wireApi !== "anthropic_messages" &&
    wireApi !== "gemini_generate_content"
  ) {
    throw new ConfigurationError(
      "wireApi must be openai_responses, openai_chat_completions, anthropic_messages or gemini_generate_content.",
    )
  }
  const envKey =
    record.envKey === undefined
      ? undefined
      : requireString(record.envKey, "envKey")
  if (envKey !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey))
    throw new ConfigurationError("envKey must be an environment variable name.")
  const preset =
    record.preset === undefined
      ? undefined
      : requireString(record.preset, "preset")
  if (!Array.isArray(record.models))
    throw new ConfigurationError(
      "models must be an array; leave it empty to discover models.",
    )
  if (record.noKey !== undefined && typeof record.noKey !== "boolean")
    throw new ConfigurationError("noKey must be a boolean.")
  if (record.enabled !== undefined && typeof record.enabled !== "boolean")
    throw new ConfigurationError("enabled must be a boolean.")
  if (
    record.modelSelection !== undefined &&
    record.modelSelection !== "all" &&
    record.modelSelection !== "selected"
  )
    throw new ConfigurationError("modelSelection must be all or selected.")
  if (
    record.requestWarmup !== undefined &&
    typeof record.requestWarmup !== "boolean"
  )
    throw new ConfigurationError("requestWarmup must be a boolean.")
  if (
    record.requestWarmup === true &&
    (wireApi !== "openai_responses" || !supportsOpenAIRequestWarmup(baseURL))
  )
    throw new ConfigurationError(
      "Request warmup is supported only by the official OpenAI Responses API endpoint.",
    )
  const models = requireConfiguredModels(record.models)
  return {
    name,
    wireApi,
    baseURL,
    models,
    ...(envKey === undefined ? {} : { envKey }),
    ...(preset === undefined ? {} : { preset }),
    ...(record.noKey === undefined ? {} : { noKey: record.noKey }),
    ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
    ...(record.requestWarmup === undefined
      ? {}
      : { requestWarmup: record.requestWarmup }),
    ...(record.modelSelection === undefined
      ? {}
      : { modelSelection: record.modelSelection }),
  }
}

export function requireConfiguredModels(
  value: unknown,
): readonly ConfiguredModel[] {
  if (!Array.isArray(value))
    throw new ConfigurationError("models must be an array.")
  const models = value.map((value): ConfiguredModel => {
    const model = requireRecord(value, "Model")
    const id = requireString(model.id, "Model id")
    const displayName =
      model.displayName === undefined
        ? undefined
        : requireString(model.displayName, "Model displayName")
    let pricing: ConfiguredModel["pricing"]
    if (model.pricing !== undefined) {
      const prices = requireRecord(model.pricing, "Model pricing")
      const price = (key: string) => {
        const value = prices[key]
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          throw new ConfigurationError(
            `Model pricing.${key} must be a non-negative number.`,
          )
        return value
      }
      pricing = {
        inputPerMillion: price("inputPerMillion"),
        outputPerMillion: price("outputPerMillion"),
        ...(prices.cacheReadPerMillion === undefined
          ? {}
          : { cacheReadPerMillion: price("cacheReadPerMillion") }),
        ...(prices.cacheWritePerMillion === undefined
          ? {}
          : { cacheWritePerMillion: price("cacheWritePerMillion") }),
      }
    }
    const contextWindowTokens = optionalPositiveInteger(
      model.contextWindowTokens,
      "contextWindowTokens",
    )
    const maxOutputTokens = optionalPositiveInteger(
      model.maxOutputTokens,
      "maxOutputTokens",
    )
    const contextWindowScope = model.contextWindowScope
    if (
      contextWindowScope !== undefined &&
      contextWindowScope !== "input" &&
      contextWindowScope !== "total"
    )
      throw new ConfigurationError("contextWindowScope must be input or total.")
    if (
      contextWindowScope !== "input" &&
      contextWindowTokens !== undefined &&
      maxOutputTokens !== undefined &&
      maxOutputTokens > contextWindowTokens
    )
      throw new ConfigurationError(
        "maxOutputTokens cannot exceed contextWindowTokens.",
      )
    const inputModalities = model.inputModalities
    if (
      inputModalities !== undefined &&
      (!Array.isArray(inputModalities) ||
        inputModalities.length === 0 ||
        inputModalities.some(
          (item) => item !== "text" && item !== "image" && item !== "video",
        ))
    )
      throw new ConfigurationError(
        "inputModalities must contain text, image or video.",
      )
    const efforts = model.efforts
    if (
      efforts !== undefined &&
      (!Array.isArray(efforts) ||
        efforts.some((item) => typeof item !== "string" || item.trim() === ""))
    )
      throw new ConfigurationError(
        "efforts must be a list of non-empty strings.",
      )
    const defaultEffort =
      model.defaultEffort === undefined
        ? undefined
        : requireString(model.defaultEffort, "defaultEffort")
    if (
      defaultEffort !== undefined &&
      (!Array.isArray(efforts) || !efforts.includes(defaultEffort))
    )
      throw new ConfigurationError("defaultEffort must appear in efforts.")
    let instructionProfileId: ConfiguredModel["instructionProfileId"]
    if (model.instructionProfileId !== undefined) {
      const profile = requireString(
        model.instructionProfileId,
        "instructionProfileId",
      )
      try {
        instructionProfileId = requireInstructionProfileId(profile)
      } catch (cause) {
        throw new ConfigurationError(
          `Unknown instructionProfileId: ${profile}.`,
          {
            cause,
          },
        )
      }
    }
    return {
      id,
      ...(pricing ? { pricing } : {}),
      ...(displayName === undefined ? {} : { displayName }),
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      ...(contextWindowScope === undefined ? {} : { contextWindowScope }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(inputModalities === undefined
        ? {}
        : {
            inputModalities: inputModalities as NonNullable<
              ConfiguredModel["inputModalities"]
            >,
          }),
      ...(efforts === undefined ? {} : { efforts: efforts as string[] }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(instructionProfileId === undefined ? {} : { instructionProfileId }),
    }
  })
  if (
    new Set(models.map((model) => model.id.toLowerCase())).size !==
    models.length
  )
    throw new ConfigurationError(
      "Model ids must be unique within a connection.",
    )
  return models
}

// The connection/protocol split follows grok-build model_providers. Model rows
// remain connection-scoped because Yakitori's top-level `model` is a selected
// default slug, and the GUI edits/deletes a connection with its model choices.
export function providersFromConfig(
  value: unknown,
): Readonly<Record<string, StoredProviderConfiguration>> {
  if (value === undefined) return {}
  const entries = requireRecord(value, "model_providers")
  return Object.fromEntries(
    Object.entries(entries).map(([id, value]) => {
      requireProviderId(id)
      const record = requireRecord(value, `model_providers.${id}`)
      const backend = record.api_backend
      const configuration = requireProviderConfiguration({
        name: record.name ?? id,
        baseURL: record.base_url,
        wireApi:
          backend === "responses"
            ? "openai_responses"
            : backend === "messages"
              ? "anthropic_messages"
              : backend === "chat_completions"
                ? "openai_chat_completions"
                : backend === "generate_content"
                  ? "gemini_generate_content"
                  : backend,
        envKey: record.env_key,
        preset: record.preset,
        models: record.models,
        noKey: record.no_key,
        enabled: record.enabled,
        modelSelection: record.model_selection,
      })
      const credentialRef =
        record.credential_ref === undefined
          ? undefined
          : requireString(record.credential_ref, "credential_ref")
      if (
        credentialRef !== undefined &&
        !/^key_[a-zA-Z0-9-]+$/.test(credentialRef)
      )
        throw new ConfigurationError("Invalid provider credential_ref.")
      if (record.api_key !== undefined)
        throw new ConfigurationError(
          "Use env_key or save the API key through Providers settings instead of placing api_key in config.toml.",
        )
      return [
        id,
        {
          ...configuration,
          ...(credentialRef === undefined ? {} : { credentialRef }),
        },
      ]
    }),
  )
}

export function providerConfigValue(
  configuration: StoredProviderConfiguration,
): Record<string, unknown> {
  return {
    name: configuration.name,
    base_url: configuration.baseURL,
    api_backend:
      configuration.wireApi === "openai_responses"
        ? "responses"
        : configuration.wireApi === "anthropic_messages"
          ? "messages"
          : configuration.wireApi === "gemini_generate_content"
            ? "generate_content"
            : "chat_completions",
    models: configuration.models,
    ...(configuration.modelSelection === undefined
      ? {}
      : { model_selection: configuration.modelSelection }),
    ...(configuration.noKey === undefined
      ? {}
      : { no_key: configuration.noKey }),
    ...(configuration.enabled === undefined
      ? {}
      : { enabled: configuration.enabled }),
    ...(configuration.preset === undefined
      ? {}
      : { preset: configuration.preset }),
    ...(configuration.envKey === undefined
      ? {}
      : { env_key: configuration.envKey }),
    ...(configuration.credentialRef === undefined
      ? {}
      : { credential_ref: configuration.credentialRef }),
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ConfigurationError(`${name} must be an object.`)
  return value as Record<string, unknown>
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ConfigurationError(`${name} must be a non-empty string.`)
  return value.trim()
}

function optionalPositiveInteger(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new ConfigurationError(`${name} must be a positive integer.`)
  return value
}
