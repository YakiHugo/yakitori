import { createHash } from "node:crypto"
import type {
  EventMetadata,
  InputRole,
  JsonObject,
  JsonValue,
  ModelSelection,
  InputContent,
} from "./events.ts"

export function fingerprintOperation(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function fingerprintInputAdmission(data: {
  readonly role: InputRole
  readonly content: InputContent
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

// turn_started stores the admission hash, including the old wire shape. Only
// restored admissions may try this fallback; interleaving has no legacy representation.
export function matchesStoredLegacyInputFingerprint(
  fingerprint: string,
  data: Parameters<typeof fingerprintInputAdmission>[0],
  options: { goalId?: string; manualCompact?: boolean } = {},
): boolean {
  const first = data.content.parts[0]
  const remaining =
    first?.type === "text" ? data.content.parts.slice(1) : data.content.parts
  if (remaining.some((part) => part.type !== "image")) return false
  const attachments = remaining.map((part) => {
    if (part.type !== "image")
      throw new TypeError("Legacy input images must follow text.")
    const { type: _type, ...image } = part
    return image
  })
  const legacy = fingerprintOperation({
    role: data.role,
    content: {
      kind: "text",
      text: first?.type === "text" ? first.text : "",
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(data.content.contextAttachments === undefined
        ? {}
        : { contextAttachments: data.content.contextAttachments }),
    },
    ...(data.modelSelection === undefined
      ? {}
      : { modelSelection: data.modelSelection }),
    parentInputId: data.parentInputId ?? null,
    metadata: data.metadata ?? null,
  })
  const expected =
    options.goalId !== undefined
      ? fingerprintOperation({ goalId: options.goalId, input: legacy })
      : options.manualCompact === true
        ? `compact:${legacy}`
        : legacy
  return expected === fingerprint
}
