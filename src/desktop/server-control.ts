import type { ImageAttachment } from "../kernel/events.ts"

export type ServerControlCommand =
  | {
      readonly type: "import_image_paths"
      readonly sessionId: string
      readonly ownerId: string
      readonly paths: readonly string[]
    }
  | {
      readonly type: "discard_draft_images"
      readonly attachments: readonly ImageAttachment[]
    }

export type ServerControlRequest = ServerControlCommand & {
  readonly requestId: string
}

export type ServerControlResponse =
  | {
      readonly requestId: string
      readonly ok: true
      readonly attachments?: readonly ImageAttachment[]
    }
  | {
      readonly requestId: string
      readonly ok: false
      readonly error: string
    }

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
        value.attachments.every(isImageAttachment))
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
  if (value.type === "import_image_paths") {
    return (
      "sessionId" in value &&
      typeof value.sessionId === "string" &&
      "ownerId" in value &&
      typeof value.ownerId === "string" &&
      "paths" in value &&
      Array.isArray(value.paths) &&
      value.paths.every((path) => typeof path === "string")
    )
  }
  return (
    value.type === "discard_draft_images" &&
    "attachments" in value &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isImageAttachment)
  )
}

function isImageAttachment(value: unknown): value is ImageAttachment {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "mediaType" in value &&
    (value.mediaType === "image/png" ||
      value.mediaType === "image/jpeg" ||
      value.mediaType === "image/gif" ||
      value.mediaType === "image/webp") &&
    "sizeBytes" in value &&
    typeof value.sizeBytes === "number" &&
    "detail" in value &&
    (value.detail === "high" || value.detail === "original") &&
    "file" in value &&
    typeof value.file === "object" &&
    value.file !== null &&
    "rolloutId" in value.file &&
    typeof value.file.rolloutId === "string" &&
    "path" in value.file &&
    typeof value.file.path === "string"
  )
}
