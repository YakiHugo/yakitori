import { createHash } from "node:crypto"
import type {
  EventMetadata,
  InputRole,
  JsonObject,
  JsonValue,
  ModelSelection,
  TextContent,
} from "./events.ts"

export function fingerprintOperation(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function fingerprintInputAdmission(data: {
  readonly role: InputRole
  readonly content: TextContent
  readonly modelSelection?: ModelSelection | undefined
  readonly parentInputId?: string | undefined
  readonly metadata?: EventMetadata | undefined
}): string {
  return fingerprintOperation({
    role: data.role,
    content: data.content,
    ...(data.modelSelection === undefined
      ? {}
      : { modelSelection: data.modelSelection }),
    parentInputId: data.parentInputId ?? null,
    metadata: data.metadata ?? null,
  })
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
