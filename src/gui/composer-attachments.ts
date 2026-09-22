import type { ImageAttachment } from "../kernel/events.ts"
import { apiUrl } from "./lib/api-client.ts"

export async function appendPickedImages(
  current: readonly ImageAttachment[],
  sessionId: string | undefined,
  selectionId: string,
): Promise<readonly ImageAttachment[]> {
  const added = await requireDesktopBridge().importPickedImages({
    ...(sessionId === undefined ? {} : { sessionId }),
    selectionId,
  })
  return [...current, ...added]
}

export async function pickImages(): Promise<
  { readonly selectionId: string } | undefined
> {
  return requireDesktopBridge().pickImages()
}

export async function discardPickedImages(selectionId: string): Promise<void> {
  await requireDesktopBridge().discardPickedImages({ selectionId })
}

export function validateImageFiles(files: readonly File[]): void {
  if (files.some((file) => !file.type.startsWith("image/"))) {
    throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached.")
  }
  if (files.some((file) => file.size > 50_000_000)) {
    throw new Error("Image must be no larger than 50 MB.")
  }
}

export async function appendImageFiles(
  current: readonly ImageAttachment[],
  sessionId: string | undefined,
  files: readonly File[],
): Promise<readonly ImageAttachment[]> {
  validateImageFiles(files)
  const added = await requireDesktopBridge().importImageFiles({
    ...(sessionId === undefined ? {} : { sessionId }),
    files,
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
    `/rollouts/${encodeURIComponent(attachment.file.rolloutId)}/assets/${attachment.file.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  )
}

export function requireDesktopBridge(): YakitoriDesktopBridge {
  if (window.yakitoriDesktop === undefined) {
    throw new Error("Image attachments require the Yakitori desktop app.")
  }
  return window.yakitoriDesktop
}
