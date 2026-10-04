import {
  providerPresets,
  type ConfiguredModel,
} from "../runtime/provider-presets.ts"
import type { ProviderConfiguration } from "./provider-configuration.ts"
import { ConfigurationError } from "./config-errors.ts"

// Discovery is a read-only catalog request. The timeout bounds network work
// during setup; it is an implementation safety boundary, not a model quota.
export async function discoverProviderModels(
  configuration: ProviderConfiguration,
  apiKey: string | undefined,
): Promise<readonly ConfiguredModel[]> {
  const messages = configuration.wireApi === "anthropic_messages"
  const preset = providerPresets.find(
    (entry) => entry.id === configuration.preset,
  )
  const officialPreset =
    preset?.baseURL.replace(/\/+$/, "") ===
    configuration.baseURL.replace(/\/+$/, "")
      ? preset
      : undefined
  const path = messages ? "v1/models" : "models"
  const base = `${configuration.baseURL.replace(/\/+$/, "")}/`
  const url = new URL(messages && /\/v1\/$/.test(base) ? "models" : path, base)
  if (configuration.preset === "siliconflow")
    url.searchParams.set("sub_type", "chat")
  const headers: Record<string, string> = { accept: "application/json" }
  if (apiKey && !(configuration.noKey && apiKey === "local-no-key")) {
    if (messages) headers["x-api-key"] = apiKey
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
        [404, 405].includes(response.status) &&
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
    if (!isRecord(body) || !Array.isArray(body.data))
      throw new ConfigurationError(
        "The model catalog must contain a data array.",
      )
    for (const entry of body.data) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim())
        throw new ConfigurationError("A model catalog entry has no model ID.")
      const capabilities = isRecord(entry.capabilities)
        ? entry.capabilities
        : undefined
      const architecture = isRecord(entry.architecture)
        ? entry.architecture
        : undefined
      const supportedEndpoints = entry.supported_endpoints
      if (
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
        continue
      // OpenAI's catalog also contains image, speech and embedding models,
      // while this harness sends text responses with function tools.
      if (
        officialPreset?.id === "openai" &&
        (!/^(gpt-|chatgpt-|o[1-9](?:-|$)|codex-)/.test(entry.id) ||
          /-(audio|realtime|image|transcribe|tts)(-|$)/.test(entry.id))
      )
        continue
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
        entry.max_output_tokens ?? topProvider?.max_completion_tokens
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
        effortValues.length &&
        effortValues.every((value) => typeof value === "string" && value.length)
          ? (effortValues as string[])
          : undefined
      // OpenRouter's official /models pricing is USD per token. Do not infer
      // prices for vendors that omit them, or apply another vendor's prices.
      const prices =
        configuration.preset === "openrouter" && isRecord(entry.pricing)
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
      models.set(entry.id, {
        id: entry.id,
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
      })
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
  const preferred =
    providerPresets
      .find((entry) => entry.id === configuration.preset)
      ?.models.map((model) => model.id) ?? []
  return [...models.values()].sort((a, b) => {
    const first = preferred.indexOf(a.id)
    const second = preferred.indexOf(b.id)
    return (
      (first < 0 ? preferred.length : first) -
      (second < 0 ? preferred.length : second)
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
