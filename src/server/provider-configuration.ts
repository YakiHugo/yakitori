import type { ProviderConfiguration } from "../protocol/providers.ts"

export type {
  ApiConfiguredProvider,
  ProviderConfiguration,
} from "../protocol/providers.ts"

import { requireInstructionProfileId } from "../runtime/model-catalog.ts"
import { resolveProviderBackend } from "../runtime/provider-backend.ts"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"
import { providerServices } from "../runtime/provider-services.ts"
import { supportsOpenAIRequestWarmup } from "../shared/request-warmup-policy.ts"
import { ConfigurationError } from "./config-errors.ts"

export type StoredProviderConfiguration = ProviderConfiguration &
  Readonly<{
    credentialRef?: string
  }>

export function requireProviderId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_-]*$/.test(value) ||
    value.startsWith("chatgpt-") ||
    ["__proto__", "constructor", "prototype", "faux", "codex"].includes(value)
  ) {
    throw new ConfigurationError(
      "Provider id must start with a lowercase letter and contain only lowercase letters, numbers, underscores or hyphens. faux, codex and the chatgpt- prefix are reserved.",
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
    wireApi !== "gemini_generate_content" &&
    wireApi !== "gemini_interactions"
  ) {
    throw new ConfigurationError(
      "wireApi must be openai_responses, openai_chat_completions, anthropic_messages, gemini_generate_content or gemini_interactions.",
    )
  }
  const envKey =
    record.envKey === undefined
      ? undefined
      : requireString(record.envKey, "envKey")
  if (envKey !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey))
    throw new ConfigurationError("envKey must be an environment variable name.")
  const authentication = record.authentication ?? "stored"
  if (
    !["stored", "environment", "none", "codex_cli", "grok_cli"].includes(
      String(authentication),
    )
  )
    throw new ConfigurationError("Unknown account authentication source.")
  if (authentication === "environment" && envKey === undefined)
    throw new ConfigurationError("Environment authentication requires envKey.")
  const external =
    authentication === "codex_cli" || authentication === "grok_cli"
  const credentialPath = external
    ? requireString(record.credentialPath, "credentialPath")
    : undefined
  const credentialOwner = external
    ? requireString(record.credentialOwner, "credentialOwner")
    : undefined
  const preset =
    record.preset === undefined
      ? undefined
      : requireString(record.preset, "preset")
  const service =
    record.service === undefined
      ? "generic"
      : requireString(record.service, "service")
  if (
    service !== "generic" &&
    service !== "codex" &&
    !providerServices.some((entry) => entry.id === service)
  )
    throw new ConfigurationError("Unknown account service.")
  const backend = resolveProviderBackend({ service, baseURL, wireApi })
  if (
    external &&
    (wireApi !== "openai_responses" ||
      backend.serviceId !== (authentication === "codex_cli" ? "codex" : "xai"))
  )
    throw new ConfigurationError(
      "CLI authentication must use its matching service, documented endpoint and protocol.",
    )
  if (service === "codex" && authentication !== "codex_cli")
    throw new ConfigurationError(
      "The Codex service requires CLI authentication.",
    )
  if (!Array.isArray(record.models))
    throw new ConfigurationError(
      "models must be an array; leave it empty to discover models.",
    )
  if (record.enabled !== undefined && typeof record.enabled !== "boolean")
    throw new ConfigurationError("enabled must be a boolean.")
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
    service,
    wireApi,
    baseURL,
    authentication: authentication as NonNullable<
      ProviderConfiguration["authentication"]
    >,
    ...(credentialPath === undefined || credentialOwner === undefined
      ? {}
      : { credentialPath, credentialOwner }),
    models,
    ...(envKey === undefined ? {} : { envKey }),
    ...(preset === undefined ? {} : { preset }),
    ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
    ...(record.requestWarmup === undefined
      ? {}
      : { requestWarmup: record.requestWarmup }),
  }
}

export function requireConfiguredModels(
  value: unknown,
  options: Readonly<{ inheritEfforts?: boolean }> = {},
): readonly ConfiguredModel[] {
  if (!Array.isArray(value))
    throw new ConfigurationError("models must be an array.")
  const models = value.map((value): ConfiguredModel => {
    const model = requireRecord(value, "Model")
    const id = requireString(model.id, "Model id")
    let identity: ConfiguredModel["identity"]
    if (model.identity !== undefined) {
      const record = requireRecord(model.identity, "Model identity")
      identity = {
        namespace: requireString(record.namespace, "identity.namespace"),
        model: requireString(record.model, "identity.model"),
      }
    }
    if (
      model.kind !== undefined &&
      !["chat", "image", "video", "other"].includes(String(model.kind))
    )
      throw new ConfigurationError(
        "Model kind must be chat, image, video or other.",
      )
    if (
      model.defaultVisible !== undefined &&
      typeof model.defaultVisible !== "boolean"
    )
      throw new ConfigurationError("Model defaultVisible must be a boolean.")
    if (model.visible !== undefined && typeof model.visible !== "boolean")
      throw new ConfigurationError("Model visible must be a boolean.")
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
    const maxContextWindowTokens = optionalPositiveInteger(
      model.maxContextWindowTokens,
      "maxContextWindowTokens",
    )
    const speeds = model.speeds
    if (
      speeds !== undefined &&
      (!Array.isArray(speeds) ||
        speeds.some((value) => typeof value !== "string" || !value.trim()))
    )
      throw new ConfigurationError(
        "speeds must be an array of non-empty strings.",
      )
    const imageDetailModes = model.imageDetailModes
    if (
      imageDetailModes !== undefined &&
      (!Array.isArray(imageDetailModes) ||
        imageDetailModes.some(
          (value) => value !== "high" && value !== "original",
        ))
    )
      throw new ConfigurationError(
        "imageDetailModes must contain high or original.",
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
      (efforts === undefined
        ? !options.inheritEfforts
        : !efforts.includes(defaultEffort))
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
      ...(identity === undefined ? {} : { identity }),
      ...(model.kind === undefined
        ? {}
        : { kind: model.kind as NonNullable<ConfiguredModel["kind"]> }),
      ...(model.defaultVisible === undefined
        ? {}
        : { defaultVisible: model.defaultVisible as boolean }),
      ...(model.visible === undefined
        ? {}
        : { visible: model.visible as boolean }),
      ...(pricing ? { pricing } : {}),
      ...(maxContextWindowTokens === undefined
        ? {}
        : { maxContextWindowTokens }),
      ...(speeds === undefined ? {} : { speeds: speeds as string[] }),
      ...(imageDetailModes === undefined
        ? {}
        : { imageDetailModes: imageDetailModes as ("high" | "original")[] }),
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
                  : backend === "interactions"
                    ? "gemini_interactions"
                    : backend,
        envKey: record.env_key,
        authentication: record.authentication,
        credentialPath: record.credential_path,
        credentialOwner: record.credential_owner,
        preset: record.preset,
        service: record.service,
        models: record.models,
        enabled: record.enabled,
        requestWarmup: record.request_warmup,
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
      if (
        credentialRef !== undefined &&
        configuration.authentication !== "stored"
      )
        throw new ConfigurationError(
          "Only saved-key accounts may reference a stored credential.",
        )
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
    service: configuration.service ?? "generic",
    authentication: configuration.authentication ?? "stored",
    ...(configuration.credentialPath === undefined
      ? {}
      : {
          credential_path: configuration.credentialPath,
          credential_owner: configuration.credentialOwner,
        }),
    base_url: configuration.baseURL,
    api_backend:
      configuration.wireApi === "openai_responses"
        ? "responses"
        : configuration.wireApi === "anthropic_messages"
          ? "messages"
          : configuration.wireApi === "gemini_generate_content"
            ? "generate_content"
            : configuration.wireApi === "gemini_interactions"
              ? "interactions"
              : "chat_completions",
    models: configuration.models,
    ...(configuration.enabled === undefined
      ? {}
      : { enabled: configuration.enabled }),
    ...(configuration.requestWarmup === undefined
      ? {}
      : { request_warmup: configuration.requestWarmup }),
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
