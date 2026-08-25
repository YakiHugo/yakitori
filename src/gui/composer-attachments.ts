import type { ImageAttachment } from "../kernel/events.ts"
import { apiUrl } from "./lib/api-client.ts"

export async function appendPickedImages(
  current: readonly ImageAttachment[],
  sessionId: string,
): Promise<readonly ImageAttachment[]> {
  const added = await requireDesktopBridge().pickImages({ sessionId })
  return [...current, ...added]
}

export async function appendImageFiles(
  current: readonly ImageAttachment[],
  sessionId: string,
  files: readonly File[],
): Promise<readonly ImageAttachment[]> {
  const candidates = files.filter((file) => file.type.startsWith("image/"))
  if (candidates.length !== files.length) {
    throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached.")
  }
  if (candidates.some((file) => file.size > 50_000_000)) {
    throw new Error("Image must be no larger than 50 MB.")
  }
  const added = await requireDesktopBridge().importImageFiles({
    sessionId,
    files: candidates,
  })
  return [...current, ...added]
}

export async function discardDraftImages(
  attachments: readonly ImageAttachment[],
): Promise<void> {
  await requireDesktopBridge().discardDraftImages(attachments)
}

export function imageAttachmentUrl(
  attachment: ImageAttachment,
  apiBase = window.location.origin,
): string {
  return apiUrl(
    apiBase,
    `/sessions/${encodeURIComponent(attachment.file.sessionId)}/files/${attachment.file.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  )
}

function requireDesktopBridge(): YakitoriDesktopBridge {
  if (window.yakitoriDesktop === undefined) {
    throw new Error("Image attachments require the Yakitori desktop app.")
  }
  return window.yakitoriDesktop
}
