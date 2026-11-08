import { anthropicModel } from "../runtime/anthropic-models.ts"
import { configuredModelWithDefaults } from "../runtime/configured-model-defaults.ts"
import { geminiModelMetadata } from "../runtime/gemini-models.ts"
import { isMetaContributorModel } from "../runtime/meta-models.ts"
import { parseOpenAiCompatibleModel } from "../runtime/model-discovery.ts"
import { sortModelCatalog } from "../protocol/model-catalog-order.ts"
import { discoveredModelKind } from "../runtime/model-kind.ts"
import type { ConfiguredModel } from "../runtime/provider-presets.ts"
import { providerServiceForEndpoint } from "../runtime/provider-services.ts"
import { stepfunDiscoveredMetadata } from "../runtime/stepfun-models.ts"
import { ConfigurationError } from "./config-errors.ts"
import type { ProviderConfiguration } from "./provider-configuration.ts"
import { providerDiscoveryPolicy } from "./provider-discovery-policy.ts"

// Discovery is a read-only catalog request. The timeout bounds network work
// during setup; it is an implementation safety boundary, not a model quota.
export async function discoverProviderModels(
  configuration: ProviderConfiguration,
  apiKey: string | undefined,
): Promise<readonly ConfiguredModel[]> {
  const messages = configuration.wireApi === "anthropic_messages"
  const gemini =
    configuration.wireApi === "gemini_generate_content" ||
    configuration.wireApi === "gemini_interactions"
  const officialPreset = providerServiceForEndpoint(configuration)
  const policy = providerDiscoveryPolicy(officialPreset)
  // A documented static catalog does not verify credentials or account access.
  if (policy.source === "preset" && officialPreset !== undefined)
    return officialPreset.models
  if (configuration.wireApi === "bedrock_converse")
    throw new ConfigurationError("No static catalog for this Bedrock endpoint.")
  const path = messages ? "v1/models" : "models"
  const base = `${configuration.baseURL.replace(/\/+$/, "")}/`
  const url = new URL(messages && /\/v1\/$/.test(base) ? "models" : path, base)
  for (const [key, value] of Object.entries(policy.query ?? {}))
    url.searchParams.set(key, value)
  const headers: Record<string, string> = { accept: "application/json" }
  if (
    apiKey &&
    !(configuration.authentication === "none" && apiKey === "local-no-key")
  ) {
    if (messages) headers["x-api-key"] = apiKey
    else if (gemini) headers["x-goog-api-key"] = apiKey
    else headers.Authorization = `Bearer ${apiKey}`
  }
  if (messages) headers["anthropic-version"] = "2023-06-01"
  const models = new Map<string, ConfiguredModel>()
  const pages = new Set<string>()
  const signal = AbortSignal.timeout(15_000)
  while (true) {
    if (pages.has(url.href))
      throw new ConfigurationError("Model catalog pagination repeated a page.")
    pages.add(url.href)
    let response: Response
    try {
      response = await fetch(url, { headers, signal, redirect: "error" })
    } catch (cause) {
      if (cause instanceof TypeError || signal.aborted)
        throw new ConfigurationError(
          "Could not reach the model catalog. Check the address and whether the service is running.",
          { cause },
        )
      throw cause
    }
    if (!response.ok) {
      // Some vendors implement inference without a model-list endpoint. Only
      // their unchanged official preset may use its documented model defaults;
      // custom endpoints and authentication failures must remain visible.
      if (
        pages.size === 1 &&
        !gemini &&
        [404, 405].includes(response.status) &&
        policy.missingCatalog !== "error" &&
        configuration.wireApi === officialPreset?.wireApi &&
        officialPreset?.models.length
      )
        return officialPreset.models
      throw new ConfigurationError(
        `Model catalog returned HTTP ${response.status}. Check the API key and endpoint.`,
      )
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (cause) {
      if (cause instanceof SyntaxError)
        throw new ConfigurationError("The model catalog did not return JSON.", {
          cause,
        })
      throw cause
    }
    const entries = isRecord(body)
      ? gemini
        ? body.models
        : body.data
      : undefined
    if (!isRecord(body) || !Array.isArray(entries))
      throw new ConfigurationError(
        `The model catalog must contain a ${gemini ? "models" : "data"} array.`,
      )
    const stepfunTyped =
      officialPreset?.id === "stepfun" &&
      entries.some(
        (entry) =>
          isRecord(entry) &&
          typeof entry.model_type === "string" &&
          entry.model_type.trim(),
      )
    for (const entry of entries) {
      if (gemini) {
        // Gemini's native catalog reports input/output limits separately and
        // generation methods, but no modality or reasoning-effort level list.
        // https://ai.google.dev/api/models
        if (
          !isRecord(entry) ||
          typeof entry.name !== "string" ||
          !/^models\/[^/?#\s]+$/.test(entry.name)
        )
          throw new ConfigurationError(
            "A model catalog entry has no model resource name.",
          )
        const defaultVisible =
          Array.isArray(entry.supportedGenerationMethods) &&
          entry.supportedGenerationMethods.includes("generateContent")
        const id = entry.name.slice("models/".length)
        const known =
          officialPreset?.id === "gemini" ? geminiModelMetadata(id) : undefined
        const capacity = entry.inputTokenLimit
        const output = entry.outputTokenLimit
        models.set(id, {
          id,
          ...(Array.isArray(entry.supportedGenerationMethods) && !defaultVisible
            ? { kind: "other" as const }
            : {}),
          defaultVisible: defaultVisible && known?.defaultVisible !== false,
          ...(typeof entry.displayName === "string" && entry.displayName.trim()
            ? { displayName: entry.displayName }
            : {}),
          ...(typeof capacity === "number" &&
          Number.isSafeInteger(capacity) &&
          capacity > 0
            ? { contextWindowTokens: capacity, contextWindowScope: "input" }
            : {}),
          ...(typeof output === "number" &&
          Number.isSafeInteger(output) &&
          output > 0
            ? { maxOutputTokens: output }
            : {}),
          ...(known?.inputModalities
            ? { inputModalities: known.inputModalities }
            : {}),
          ...(known?.imageDetailModes
            ? { imageDetailModes: known.imageDetailModes }
            : {}),
          ...(known?.efforts ? { efforts: known.efforts } : {}),
        })
        continue
      }
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim())
        throw new ConfigurationError("A model catalog entry has no model ID.")
      if (policy.allowedModels && !policy.allowedModels.includes(entry.id))
        continue
      // Match Step Code's typed catalog: search, audio and generation entries
      // cannot enter the coding-model picker. Untyped catalogs stay usable.
      if (
        stepfunTyped &&
        !["大语言模型", "路由模型"].includes(String(entry.model_type))
      )
        continue
      // A catalog response is not consent to use private content for training.
      if (officialPreset?.id === "meta" && isMetaContributorModel(entry.id))
        continue
      // Reka serves third-party models too. Only this exact first-party model
      // has a complete coding/vision contract adapted here; Flash 3 lacks tools.
      // GET /models is authoritative for account availability.
      if (
        officialPreset?.id === "reka" &&
        (entry.is_ready === false ||
          (Array.isArray(entry.supported_features) &&
            !entry.supported_features.includes("tools")))
      )
        continue
      if (officialPreset?.id === "anthropic" && messages) {
        if (entry.lifecycle !== "retired")
          models.set(
            entry.id,
            parseAnthropicModel(
              entry as Record<string, unknown> & { id: string },
            ),
          )
        continue
      }
      const capabilities = isRecord(entry.capabilities)
        ? entry.capabilities
        : undefined
      const architecture = isRecord(entry.architecture)
        ? entry.architecture
        : undefined
      const supportedEndpoints = entry.supported_endpoints
      const defaultVisible = !(
        capabilities?.completion_chat === false ||
        (Array.isArray(supportedEndpoints) &&
          !supportedEndpoints.includes(
            configuration.wireApi === "openai_responses"
              ? "/responses"
              : messages
                ? "/messages"
                : "/chat/completions",
          )) ||
        (Array.isArray(architecture?.output_modalities) &&
          !architecture.output_modalities.includes("text"))
      )
      const name =
        typeof entry.display_name === "string"
          ? entry.display_name
          : typeof entry.name === "string"
            ? entry.name
            : undefined
      const capacity = entry.context_length
      const topProvider = isRecord(entry.top_provider)
        ? entry.top_provider
        : undefined
      const output =
        entry.max_output_tokens ??
        (policy.maxOutputTokensField === undefined
          ? undefined
          : entry[policy.maxOutputTokensField]) ??
        topProvider?.max_completion_tokens
      const modalities =
        architecture?.input_modalities ?? entry.input_modalities
      const inputModalities = Array.isArray(modalities)
        ? modalities.filter(
            (value): value is "text" | "image" =>
              value === "text" || value === "image",
          )
        : undefined
      const effortValues =
        entry.supported_reasoning_efforts ??
        (isRecord(entry.think_efforts)
          ? entry.think_efforts.valid_efforts
          : undefined)
      const efforts =
        Array.isArray(effortValues) &&
        effortValues.every((value) => typeof value === "string" && value.length)
          ? (effortValues as string[])
          : undefined
      // OpenRouter's official /models pricing is USD per token. Do not infer
      // prices for vendors that omit them, or apply another vendor's prices.
      const prices =
        officialPreset?.id === "openrouter" && isRecord(entry.pricing)
          ? entry.pricing
          : undefined
      const price = (value: unknown) => {
        const amount =
          typeof value === "string" && value.trim() ? Number(value) : value
        return typeof amount === "number" &&
          Number.isFinite(amount) &&
          amount >= 0
          ? amount * 1_000_000
          : undefined
      }
      const inputPrice = price(prices?.prompt),
        outputPrice = price(prices?.completion)
      const cacheRead = price(prices?.input_cache_read),
        cacheWrite = price(prices?.input_cache_write)
      const nativeProvider = officialPreset?.catalogProvider
      const nativeFacts =
        nativeProvider === "grok" || nativeProvider === "kimi-code"
          ? parseOpenAiCompatibleModel(nativeProvider, {
              ...entry,
              id: entry.id,
            })
          : {}
      const kind = discoveredModelKind(
        entry,
        nativeProvider,
        configuration.wireApi,
      )
      const discovered: ConfiguredModel = {
        id: entry.id,
        defaultVisible,
        ...(name ? { displayName: name } : {}),
        ...(typeof capacity === "number" &&
        Number.isSafeInteger(capacity) &&
        capacity > 0
          ? { contextWindowTokens: capacity }
          : {}),
        ...(typeof output === "number" &&
        Number.isSafeInteger(output) &&
        output > 0
          ? { maxOutputTokens: output }
          : {}),
        ...(inputModalities?.length ? { inputModalities } : {}),
        ...(efforts ? { efforts } : {}),
        ...(inputPrice !== undefined && outputPrice !== undefined
          ? {
              pricing: {
                inputPerMillion: inputPrice,
                outputPerMillion: outputPrice,
                ...(cacheRead === undefined
                  ? {}
                  : { cacheReadPerMillion: cacheRead }),
                ...(cacheWrite === undefined
                  ? {}
                  : { cacheWritePerMillion: cacheWrite }),
              },
            }
          : {}),
        ...nativeFacts,
        ...(officialPreset?.id === "stepfun"
          ? stepfunDiscoveredMetadata({ ...entry, id: entry.id })
          : {}),
        ...(kind === undefined ? {} : { kind }),
      }
      models.set(
        entry.id,
        configuredModelWithDefaults(
          discovered,
          policy.fillPresetMetadata
            ? officialPreset?.models.find((model) => model.id === entry.id)
            : undefined,
        ),
      )
    }
    if (gemini) {
      if (body.nextPageToken === undefined || body.nextPageToken === "") break
      if (typeof body.nextPageToken !== "string")
        throw new ConfigurationError(
          "The model catalog has an invalid nextPageToken.",
        )
      url.searchParams.set("pageToken", body.nextPageToken)
      continue
    }
    if (body.has_more !== true) break
    if (typeof body.last_id !== "string" || !body.last_id)
      throw new ConfigurationError(
        "The model catalog has another page but no last_id.",
      )
    url.searchParams.set("after_id", body.last_id)
  }
  if (!models.size)
    throw new ConfigurationError(
      "This service reports no chat models. Load a model in the local service, or check this account's access.",
    )
  const preferred = officialPreset?.models.map((model) => model.id) ?? []
  return sortModelCatalog([...models.values()], preferred)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Native Models API fields are not OpenAI-compatible context_length metadata.
// Use published capabilities for new IDs without guessing from their names.
// https://platform.claude.com/docs/en/api/models/list
function parseAnthropicModel(
  entry: Record<string, unknown> & { id: string },
): ConfiguredModel {
  const known = anthropicModel(entry.id)?.configuration
  const capabilities = isRecord(entry.capabilities)
    ? entry.capabilities
    : undefined
  const image = isRecord(capabilities?.image_input)
    ? capabilities.image_input.supported
    : undefined
  const effort = isRecord(capabilities?.effort)
    ? capabilities.effort
    : undefined
  const thinking = isRecord(capabilities?.thinking)
    ? capabilities.thinking
    : undefined
  const types = isRecord(thinking?.types) ? thinking.types : undefined
  const supports = (value: unknown) =>
    isRecord(value) && value.supported === true
  const efforts =
    effort === undefined
      ? known?.efforts
      : [
          ...(supports(types?.disabled) || supports(types?.between_tools)
            ? ["off"]
            : []),
          ...["low", "medium", "high", "xhigh", "max"].filter(
            (level) => effort.supported !== false && supports(effort[level]),
          ),
        ]
  const { defaultEffort, ...facts } = known ?? {}
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
  return {
    ...facts,
    id: entry.id,
    defaultVisible: true,
    ...(typeof entry.display_name === "string" && entry.display_name.trim()
      ? { displayName: entry.display_name }
      : {}),
    ...(positive(entry.max_input_tokens)
      ? {
          contextWindowTokens: entry.max_input_tokens,
          contextWindowScope: "input",
        }
      : {}),
    ...(positive(entry.max_tokens)
      ? { maxOutputTokens: entry.max_tokens }
      : {}),
    ...(typeof image === "boolean"
      ? { inputModalities: image ? ["text", "image"] : ["text"] }
      : {}),
    ...(efforts === undefined ? {} : { efforts }),
    ...(defaultEffort !== undefined && efforts?.includes(defaultEffort)
      ? { defaultEffort }
      : {}),
  }
}
