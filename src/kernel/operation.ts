import { createHash } from "node:crypto"
import type { JsonObject, JsonValue } from "./events.ts"

export function fingerprintOperation(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (isJsonObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => {
        if (left < right) return -1
        if (left > right) return 1
        return 0
      })
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`
  }

  return `[${value.map((item) => canonicalJson(item)).join(",")}]`
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
