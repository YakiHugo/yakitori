import type { DiscoveredModel } from "./models-manager.ts"

export async function discoverOpenAiCompatibleModels(input: {
  baseUrl: string
  accessToken: string
  fetchFn?: typeof fetch
}): Promise<readonly DiscoveredModel[]> {
  const response = await (input.fetchFn ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/models`,
    {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) {
    throw new Error(
      `Model discovery failed with HTTP ${String(response.status)}.`,
    )
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Model discovery returned an invalid response.")
  }
  return payload.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return []
    return [{ id: entry.id }]
  })
}

export async function discoverCodexModels(input: {
  baseUrl: string
  accessToken: string
  accountId?: string
  fetchFn?: typeof fetch
}): Promise<readonly DiscoveredModel[]> {
  const response = await (input.fetchFn ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/models?client_version=0.0.0`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        ...(input.accountId === undefined
          ? {}
          : { "chatgpt-account-id": input.accountId }),
      },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) {
    throw new Error(
      `Codex model discovery failed with HTTP ${String(response.status)}.`,
    )
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("Codex model discovery returned an invalid response.")
  }
  return payload.models.flatMap((entry) => parseCodexModel(entry))
}

function parseCodexModel(value: unknown): readonly DiscoveredModel[] {
  if (!isRecord(value)) return []
  const id = stringValue(value.slug) ?? stringValue(value.id)
  if (id === undefined) return []
  const displayName = stringValue(value.display_name ?? value.displayName)
  const contextWindowTokens = positiveInteger(
    value.context_window ?? value.contextWindow,
  )
  const maxContextWindowTokens = positiveInteger(
    value.max_context_window ?? value.maxContextWindow,
  )
  const effectiveContextWindowPercent = positiveNumber(
    value.effective_context_window_percent ??
      value.effectiveContextWindowPercent,
  )
  const autoCompactTokenLimit = positiveInteger(
    value.auto_compact_token_limit ?? value.autoCompactTokenLimit,
  )
  const compactionHash = stringValue(
    value.compaction_hash ?? value.compactionHash,
  )
  return [
    {
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      ...(maxContextWindowTokens === undefined
        ? {}
        : { maxContextWindowTokens }),
      ...(effectiveContextWindowPercent === undefined
        ? {}
        : { effectiveContextWindowPercent }),
      ...(autoCompactTokenLimit === undefined ? {} : { autoCompactTokenLimit }),
      ...(compactionHash === undefined ? {} : { compactionHash }),
    },
  ]
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
