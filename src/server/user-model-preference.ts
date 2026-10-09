import {
  ApiErrorCode,
  type ApiUserModelPreference,
} from "../protocol/application.ts"
import type { ApplicationResult } from "./application-result.ts"

function requireBodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function requireUserModelPreference(
  value: unknown,
  availableProviders: readonly string[],
):
  | { readonly ok: true; readonly value: ApiUserModelPreference }
  | { readonly ok: false; readonly result: ApplicationResult<never> } {
  const record = requireBodyRecord(value)
  const provider = nonEmptyString(record.provider)
  if (provider === undefined) {
    return {
      ok: false,
      result: invalidPreference("provider must be a non-empty string."),
    }
  }
  if (!availableProviders.includes(provider)) {
    return {
      ok: false,
      result: invalidPreference("provider must name a registered provider."),
    }
  }
  const model = nonEmptyString(record.model)
  if (model === undefined) {
    return {
      ok: false,
      result: invalidPreference("model must be a non-empty string."),
    }
  }
  const effort = optionalNonEmptyString(record, "effort")
  if (!effort.ok) return effort
  const speed = optionalNonEmptyString(record, "speed")
  if (!speed.ok) return speed
  return {
    ok: true,
    value: {
      provider,
      model,
      ...(effort.value === undefined ? {} : { effort: effort.value }),
      ...(speed.value === undefined ? {} : { speed: speed.value }),
    },
  }
}

function optionalNonEmptyString(
  record: Record<string, unknown>,
  field: "effort" | "speed",
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly result: ApplicationResult<never> } {
  if (!(field in record)) return { ok: true, value: undefined }
  const value = nonEmptyString(record[field])
  if (value !== undefined) return { ok: true, value }
  return {
    ok: false,
    result: invalidPreference(
      `${field} must be a non-empty string when provided.`,
    ),
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function invalidPreference(message: string): ApplicationResult<never> {
  return { ok: false, error: { code: ApiErrorCode.InvalidInput, message } }
}
