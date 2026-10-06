import type { UserAttachment } from "../kernel/events.ts"

export async function appendPickedAttachments(
  current: readonly UserAttachment[],
  sessionId: string | undefined,
  selectionId: string,
): Promise<readonly UserAttachment[]> {
  const added = await requireDesktopBridge().importPickedAttachments({
    ...(sessionId === undefined ? {} : { sessionId }),
    selectionId,
  })
  return [...current, ...added]
}

export async function pickAttachments(): Promise<
  { readonly selectionId: string } | undefined
> {
  return requireDesktopBridge().pickAttachments()
}

export async function discardPickedAttachments(
  selectionId: string,
): Promise<void> {
  await requireDesktopBridge().discardPickedAttachments({ selectionId })
}

export function validateAttachmentFiles(files: readonly File[]): void {
  if (
    files.some(
      (file) =>
        ![
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "application/pdf",
        ].includes(file.type) &&
        !(file.type === "" && /\.(pdf|png|jpe?g|gif|webp)$/i.test(file.name)),
    )
  ) {
    throw new Error("Only PDF, PNG, JPEG, GIF, and WebP files can be attached.")
  }
  if (files.some((file) => file.size === 0 || file.size > 50_000_000)) {
    throw new Error("Attachment must contain data and be no larger than 50 MB.")
  }
}

export async function appendAttachmentFiles(
  current: readonly UserAttachment[],
  sessionId: string | undefined,
  files: readonly File[],
): Promise<readonly UserAttachment[]> {
  validateAttachmentFiles(files)
  const added = await requireDesktopBridge().importAttachmentFiles({
    ...(sessionId === undefined ? {} : { sessionId }),
    files,
  })
  return [...current, ...added]
}

export async function discardDraftAttachments(
  attachments: readonly UserAttachment[],
): Promise<void> {
  await requireDesktopBridge().discardDraftAttachments(attachments)
}

export function attachmentUrl(
  attachment: UserAttachment,
  apiBase = window.location.origin,
): string {
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`
  return new URL(
    `rollouts/${encodeURIComponent(attachment.file.rolloutId)}/assets/${attachment.file.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    base,
  ).toString()
}

export function requireDesktopBridge(): YakitoriDesktopBridge {
  if (window.yakitoriDesktop === undefined) {
    throw new Error("Attachments require the Yakitori desktop app.")
  }
  return window.yakitoriDesktop
}
