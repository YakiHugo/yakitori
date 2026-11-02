import { types } from "node:util"

export class JsonRequestBudgetError extends Error {
  override readonly name = "JsonRequestBudgetError"
}

// Counts JSON.stringify's UTF-8 wire size for plain request data without
// allocating escaped strings or a serialized copy of the request. Custom
// prototypes/toJSON, accessors and proxies are rejected rather than invoked.
// Request builders must resolve executable serialization before this boundary.
// Returns undefined as soon as the wire size exceeds maxBytes.
export function jsonRequestByteLength(
  value: unknown,
  maxBytes: number,
): number | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError(
      "JSON request budget must be a nonnegative safe integer.",
    )
  let remaining = maxBytes
  const spend = (bytes: number): boolean => {
    remaining -= bytes
    return remaining >= 0
  }
  const stringFits = (text: string): boolean => {
    if (!spend(2)) return false
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      let bytes: number
      if (code === 0x22 || code === 0x5c) bytes = 2
      else if (code < 0x20)
        bytes =
          code === 8 || code === 9 || code === 10 || code === 12 || code === 13
            ? 2
            : 6
      else if (code < 0x80) bytes = 1
      else if (code < 0x800) bytes = 2
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes = 4
          index += 1
        } else bytes = 6
      } else if (code >= 0xdc00 && code <= 0xdfff) bytes = 6
      else bytes = 3
      if (!spend(bytes)) return false
    }
    return true
  }
  type Frame =
    | { kind: "value"; value: unknown }
    | { kind: "array"; value: unknown[]; index: number }
    | {
        kind: "object"
        value: Record<string, unknown>
        keys: Generator<string>
        first: boolean
      }
  const stack: Frame[] = [{ kind: "value", value }]
  const active = new Set<object>()
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame === undefined) break
    if (frame.kind === "array") {
      if (frame.index === frame.value.length) {
        if (!spend(1)) return undefined
        active.delete(frame.value)
        stack.pop()
      } else {
        if (frame.index > 0 && !spend(1)) return undefined
        const key = String(frame.index++)
        const descriptor = Object.getOwnPropertyDescriptor(frame.value, key)
        if (
          descriptor === undefined &&
          (Object.hasOwn(Array.prototype, key) ||
            Object.hasOwn(Object.prototype, key))
        )
          throw new JsonRequestBudgetError(
            "JSON request arrays cannot inherit indexed values.",
          )
        const item = descriptorValue(descriptor)
        stack.push({ kind: "value", value: item === undefined ? null : item })
      }
      continue
    }
    if (frame.kind === "object") {
      const key = frame.keys.next()
      if (key.done) {
        if (!spend(1)) return undefined
        active.delete(frame.value)
        stack.pop()
      } else {
        const item = descriptorValue(
          Object.getOwnPropertyDescriptor(frame.value, key.value),
        )
        if (item === undefined) continue
        if (!frame.first && !spend(1)) return undefined
        frame.first = false
        if (!stringFits(key.value) || !spend(1)) return undefined
        stack.push({ kind: "value", value: item })
      }
      continue
    }
    stack.pop()
    const item = frame.value
    if (item === null) {
      if (!spend(4)) return undefined
    } else if (typeof item === "string") {
      if (!stringFits(item)) return undefined
    } else if (typeof item === "boolean") {
      if (!spend(item ? 4 : 5)) return undefined
    } else if (typeof item === "number") {
      if (!spend(JSON.stringify(item).length)) return undefined
    } else if (typeof item === "object") {
      if (types.isProxy(item))
        throw new JsonRequestBudgetError(
          "JSON request data cannot contain proxies.",
        )
      if (active.has(item))
        throw new JsonRequestBudgetError("Cyclic JSON request data.")
      active.add(item)
      const prototype: unknown = Object.getPrototypeOf(item)
      if (
        Array.isArray(item)
          ? prototype !== Array.prototype
          : prototype !== null && prototype !== Object.prototype
      )
        throw new JsonRequestBudgetError(
          "JSON request data must contain only plain objects and arrays.",
        )
      assertNoCustomToJson(item)
      if (Array.isArray(item)) {
        if (!spend(1)) return undefined
        stack.push({ kind: "array", value: item, index: 0 })
      } else {
        if (!spend(1)) return undefined
        const object = item as Record<string, unknown>
        stack.push({
          kind: "object",
          value: object,
          keys: ownKeys(object),
          first: true,
        })
      }
    } else
      throw new JsonRequestBudgetError(
        "JSON request contains an unsupported value.",
      )
  }
  return maxBytes - remaining
}

// Do not eagerly materialize entries/values for wide objects: a request that
// already exceeds its budget should not allocate an array of every property.
function* ownKeys(value: Record<string, unknown>): Generator<string> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield key
  }
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor))
    throw new JsonRequestBudgetError(
      "JSON request data cannot contain accessors.",
    )
  return descriptor.value
}

function assertNoCustomToJson(value: object): void {
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON")
    if (descriptor !== undefined) {
      if (typeof descriptorValue(descriptor) === "function")
        throw new JsonRequestBudgetError(
          "JSON request data cannot contain custom toJSON methods.",
        )
      return
    }
    current = Object.getPrototypeOf(current) as object | null
  }
}
