import {
  isImageAttachment,
  isPdfAttachment,
  type UserAttachment,
} from "../kernel/events.ts"
import { isStorageKey } from "../kernel/ids.ts"

type AttachmentImportTarget = Readonly<{
  sessionId?: string
  rolloutId?: string
  ownerId: string
}>

export type ServerControlCommand =
  | (AttachmentImportTarget &
      Readonly<{
        type: "import_attachment_paths"
        paths: readonly string[]
      }>)
  | (AttachmentImportTarget &
      Readonly<{
        type: "import_attachment_bytes"
        items: readonly Readonly<{ name: string; data: Uint8Array }>[]
      }>)
  | Readonly<{
      type: "discard_draft_attachments"
      attachments: readonly UserAttachment[]
    }>

export type ServerControlRequest = ServerControlCommand &
  Readonly<{
    requestId: string
  }>

export type ServerControlResponse =
  | Readonly<{
      requestId: string
      ok: true
      attachments?: readonly UserAttachment[]
    }>
  | Readonly<{
      requestId: string
      ok: false
      error: string
    }>

export function isServerControlResponse(
  value: unknown,
): value is ServerControlResponse {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "ok" in value &&
    typeof value.ok === "boolean"
  ) {
    if (!value.ok) {
      return "error" in value && typeof value.error === "string"
    }
    return (
      !("attachments" in value) ||
      (Array.isArray(value.attachments) &&
        value.attachments.every(isAttachment))
    )
  }
  return false
}

export function isServerControlRequest(
  value: unknown,
): value is ServerControlRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    return false
  }
  if (
    value.type === "import_attachment_paths" ||
    value.type === "import_attachment_bytes"
  ) {
    const sessionId = "sessionId" in value ? value.sessionId : undefined
    const rolloutId = "rolloutId" in value ? value.rolloutId : undefined
    if (
      !(
        (isStorageKey(sessionId) && rolloutId === undefined) ||
        (isStorageKey(rolloutId) && sessionId === undefined)
      ) ||
      !("ownerId" in value) ||
      !isStorageKey(value.ownerId)
    )
      return false
    if (value.type === "import_attachment_paths") {
      return (
        "paths" in value &&
        Array.isArray(value.paths) &&
        value.paths.every((path) => typeof path === "string" && path.length > 0)
      )
    }
    return (
      "items" in value &&
      Array.isArray(value.items) &&
      value.items.every(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "name" in item &&
          typeof item.name === "string" &&
          "data" in item &&
          item.data instanceof Uint8Array,
      )
    )
  }
  return (
    value.type === "discard_draft_attachments" &&
    "attachments" in value &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isAttachment)
  )
}

function isAttachment(value: unknown): value is UserAttachment {
  return isImageAttachment(value) || isPdfAttachment(value)
}
