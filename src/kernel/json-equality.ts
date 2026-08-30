import type { JsonObject, JsonValue } from "./events.ts"

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    )
  }
  if (!isObject(left) || !isObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]),
    )
  )
}

// RFC 7386 merge patches are the durable world-state delta contract. Keep
// creation and application beside the structural JSON equality they depend on
// so producers and replay cannot disagree about whether a value changed.
export function createJsonMergePatch(
  previous: JsonObject,
  current: JsonObject,
): JsonObject | undefined {
  const patch: Record<string, JsonValue> = {}
  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(current, key)) patch[key] = null
  }
  for (const [key, currentValue] of Object.entries(current)) {
    const previousValue = previous[key]
    if (jsonValuesEqual(previousValue, currentValue)) continue
    if (isJsonObject(previousValue) && isJsonObject(currentValue)) {
      const child = createJsonMergePatch(previousValue, currentValue)
      if (child !== undefined) patch[key] = child
    } else {
      patch[key] = currentValue
    }
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

export function applyJsonMergePatch(
  target: JsonObject,
  patch: JsonObject,
): JsonObject {
  return applyMergePatchValue(target, patch) as JsonObject
}

function applyMergePatchValue(target: JsonValue, patch: JsonValue): JsonValue {
  if (!isJsonObject(patch)) return structuredClone(patch)
  const merged: Record<string, JsonValue> = isJsonObject(target)
    ? structuredClone(target)
    : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key]
      continue
    }
    merged[key] = applyMergePatchValue(merged[key] ?? null, value)
  }
  return merged
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
