import type { UserAttachment } from "./asset-types.ts"

// Local transport/storage safety boundary, independent of provider quotas.
export const ATTACHMENT_FILE_SAFETY_BYTES = 50_000_000

export function isAttachmentUploadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  )
}

export function attachmentUploadPath(uploadId: string): string {
  if (!isAttachmentUploadId(uploadId))
    throw new Error("Invalid attachment upload ID.")
  return `/attachments/uploads/${uploadId}`
}

export function uploadIdFromAttachment(
  attachment: UserAttachment,
): string | undefined {
  if (
    "url" in attachment.file ||
    !/^attachments\/staging\/upload\/1\.(png|jpg|gif|webp|pdf)$/.test(
      attachment.file.path,
    )
  )
    return undefined
  const match =
    /^draft_upload_([0-9a-f]{8})([0-9a-f]{4})(4[0-9a-f]{3})([89ab][0-9a-f]{3})([0-9a-f]{12})$/.exec(
      attachment.file.rolloutId,
    )
  return match ? match.slice(1).join("-") : undefined
}
