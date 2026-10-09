// Shared validation for the two durable facts that acknowledge renderer input.
// Native persistence uses these same checks; other native event validators stay
// in the kernel and are not part of the renderer dependency graph.
import {
  type InputAdmittedEvent,
  InputRole,
  type KernelError,
  type ModelSelection,
  type TokenUsage,
  type TurnCompletedEvent,
  type TurnCompletion,
  type TurnLatency,
  type TurnMetrics,
  type TurnOutcome,
} from "./events.ts"
import { isJsonObject } from "./json.ts"
import { isInputContent } from "./user-input.ts"
export function isTokenUsage(value: unknown): value is TokenUsage {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
      "activeContextTokens",
    ]) &&
    isNonNegativeInteger(value.inputTokens) &&
    isNonNegativeInteger(value.outputTokens) &&
    (value.cacheReadInputTokens === undefined ||
      isNonNegativeInteger(value.cacheReadInputTokens)) &&
    (value.cacheWriteInputTokens === undefined ||
      isNonNegativeInteger(value.cacheWriteInputTokens)) &&
    (value.activeContextTokens === undefined ||
      isNonNegativeInteger(value.activeContextTokens))
  )
}

export function isTurnMetrics(value: unknown): value is TurnMetrics {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "modelCalls",
      "toolCalls",
      "modelDurationMs",
      "toolDurationMs",
      "averageTimeToFirstTokenMs",
      "latency",
    ]) &&
    isNonNegativeInteger(value.modelCalls) &&
    isNonNegativeInteger(value.toolCalls) &&
    isNonNegativeInteger(value.modelDurationMs) &&
    isNonNegativeInteger(value.toolDurationMs) &&
    (value.averageTimeToFirstTokenMs === undefined ||
      isNonNegativeInteger(value.averageTimeToFirstTokenMs)) &&
    (value.latency === undefined || isTurnLatency(value.latency))
  )
}

function isTurnLatency(value: unknown): value is TurnLatency {
  const required = [
    "setupMs",
    "backgroundCompactionMs",
    "backgroundCompactionOverlapMs",
    "backgroundCompactionsApplied",
    "backgroundCompactionsDiscarded",
  ]
  const optional = [
    "admissionMs",
    "firstRequestMs",
    "firstUsefulOutputMs",
    "firstToolMs",
    "warmupMs",
    "warmupOverlapMs",
  ]
  return (
    isRecord(value) &&
    onlyKeys(value, [...required, ...optional]) &&
    required.every((key) => isNonNegativeInteger(value[key])) &&
    optional.every(
      (key) => value[key] === undefined || isNonNegativeInteger(value[key]),
    )
  )
}

export function isModelSelection(value: unknown): value is ModelSelection {
  return (
    isRecord(value) &&
    onlyKeys(value, ["provider", "model", "effort", "speed"]) &&
    isString(value.provider) &&
    value.provider.length > 0 &&
    isString(value.model) &&
    value.model.length > 0 &&
    (value.effort === undefined ||
      (isString(value.effort) && value.effort.length > 0)) &&
    (value.speed === undefined ||
      (isString(value.speed) && value.speed.length > 0))
  )
}

export function isKernelError(value: unknown): value is KernelError {
  return (
    isRecord(value) &&
    isString(value.message) &&
    (value.code === undefined || isString(value.code)) &&
    (value.details === undefined || isJsonObject(value.details))
  )
}

export function isTurnOutcome(value: unknown): value is TurnOutcome {
  if (!isRecord(value)) return false
  switch (value.status) {
    case "completed":
      return (
        onlyKeys(value, ["status", "reason", "answerItemIds"]) &&
        isTurnCompletion({
          ...(value.reason === undefined ? {} : { reason: value.reason }),
          ...(value.answerItemIds === undefined
            ? {}
            : { answerItemIds: value.answerItemIds }),
        })
      )
    case "failed":
      return onlyKeys(value, ["status", "error"]) && isKernelError(value.error)
    case "cancelled":
    case "interrupted":
      return (
        onlyKeys(value, ["status", "reason"]) &&
        (value.reason === undefined || isString(value.reason))
      )
    default:
      return false
  }
}

export function isTurnCompletion(value: unknown): value is TurnCompletion {
  return (
    isRecord(value) &&
    onlyKeys(value, ["reason", "answerItemIds"]) &&
    (value.reason === undefined ||
      value.reason === "truncated" ||
      value.reason === "refused") &&
    (value.answerItemIds === undefined ||
      (Array.isArray(value.answerItemIds) &&
        value.answerItemIds.every(
          (id) => typeof id === "string" && id.length > 0,
        ) &&
        new Set(value.answerItemIds).size === value.answerItemIds.length))
  )
}

export function isInputAdmittedData(data: Record<string, unknown>): boolean {
  return (
    onlyKeys(data, [
      "requestId",
      "inputId",
      "role",
      "content",
      "modelSelection",
      "parentInputId",
      "metadata",
      "steered",
    ]) &&
    isString(data.requestId) &&
    isString(data.inputId) &&
    isInputRole(data.role) &&
    isInputContent(data.content) &&
    (data.modelSelection === undefined ||
      isModelSelection(data.modelSelection)) &&
    (data.steered === undefined || data.steered === true) &&
    (data.metadata === undefined || isJsonObject(data.metadata)) &&
    (data.parentInputId === undefined || isString(data.parentInputId))
  )
}

export function isInputAdmittedEvent(
  value: unknown,
): value is InputAdmittedEvent {
  try {
    return (
      isRecord(value) &&
      value.type === "input.admitted" &&
      isRecord(value.data) &&
      isInputAdmittedData(value.data)
    )
  } catch {
    return false
  }
}

export function isTurnCompletedData(data: Record<string, unknown>): boolean {
  return (
    onlyKeys(data, [
      "turnId",
      "outcome",
      "usage",
      "sessionUsage",
      "metrics",
      "metadata",
    ]) &&
    isString(data.turnId) &&
    isTurnOutcome(data.outcome) &&
    (data.usage === undefined || isTokenUsage(data.usage)) &&
    (data.sessionUsage === undefined || isTokenUsage(data.sessionUsage)) &&
    (data.metrics === undefined || isTurnMetrics(data.metrics)) &&
    (data.metadata === undefined || isJsonObject(data.metadata))
  )
}

export function isTurnCompletedEvent(
  value: unknown,
): value is TurnCompletedEvent {
  try {
    return (
      isRecord(value) &&
      value.type === "turn.completed" &&
      isRecord(value.data) &&
      isTurnCompletedData(value.data)
    )
  } catch {
    return false
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function isString(value: unknown): value is string {
  return typeof value === "string"
}
function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}
const inputRoles = new Set<string>(Object.values(InputRole))
function isInputRole(value: unknown): value is InputRole {
  return typeof value === "string" && inputRoles.has(value)
}
