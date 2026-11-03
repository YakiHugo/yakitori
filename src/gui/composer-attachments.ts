import {
  isImageAttachment,
  isPdfAttachment,
  type UserAttachment,
} from "../protocol/asset-types.ts"
import {
  ATTACHMENT_FILE_SAFETY_BYTES,
  attachmentUploadPath,
  uploadIdFromAttachment,
} from "../protocol/attachment-upload.ts"
import { rolloutAssetUrl } from "./rollout-asset-url.ts"

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

// Must be invoked inside the user gesture, before queuing asynchronous imports.
export function pickAttachmentFiles(): Promise<readonly File[]> {
  const input = document.createElement("input")
  input.type = "file"
  input.multiple = true
  input.accept =
    ".pdf,.png,.jpg,.jpeg,.gif,.webp,application/pdf,image/png,image/jpeg,image/gif,image/webp"
  input.hidden = true
  document.body.append(input)
  return new Promise((resolve, reject) => {
    const finish = (files: readonly File[]) => {
      input.remove()
      resolve(files)
    }
    input.addEventListener(
      "change",
      () => finish(Array.from(input.files ?? [])),
      { once: true },
    )
    input.addEventListener("cancel", () => finish([]), { once: true })
    try {
      input.click()
    } catch (error) {
      input.remove()
      reject(error)
    }
  })
}

export function createAttachmentUploadClient(
  apiBase: string,
  request: typeof fetch = fetch,
) {
  const endpoint = (uploadId: string) =>
    new URL(attachmentUploadPath(uploadId), apiBase)
  return {
    async upload(
      file: File,
      uploadId: string,
      signal?: AbortSignal,
    ): Promise<UserAttachment> {
      const response = await request(endpoint(uploadId), {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Yakitori-Attachment": "upload",
          "X-Attachment-Name": encodeURIComponent(file.name),
        },
        body: file,
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok)
        throw new Error(`Attachment upload failed (${response.status}).`)
      const result: unknown = await response.json()
      const attachment =
        typeof result === "object" && result !== null && "attachment" in result
          ? result.attachment
          : undefined
      if (
        (!isImageAttachment(attachment) && !isPdfAttachment(attachment)) ||
        uploadIdFromAttachment(attachment) !== uploadId
      ) {
        throw new Error("Invalid attachment upload response.")
      }
      return attachment
    },
    async discard(uploadId: string): Promise<void> {
      const response = await request(endpoint(uploadId), {
        method: "DELETE",
        headers: { "X-Yakitori-Attachment": "upload" },
      })
      if (!response.ok)
        throw new Error(`Attachment cleanup failed (${response.status}).`)
    },
  }
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
  if (
    files.some(
      (file) => file.size === 0 || file.size > ATTACHMENT_FILE_SAFETY_BYTES,
    )
  ) {
    throw new Error("Attachment must contain data and be no larger than 50 MB.")
  }
}

export async function appendAttachmentFiles(
  current: readonly UserAttachment[],
  sessionId: string | undefined,
  files: readonly File[],
  apiBase = window.location.origin,
  signal?: AbortSignal,
): Promise<readonly UserAttachment[]> {
  validateAttachmentFiles(files)
  if (window.yakitoriDesktop !== undefined) {
    const added = await window.yakitoriDesktop.importAttachmentFiles({
      ...(sessionId === undefined ? {} : { sessionId }),
      files,
    })
    return [...current, ...added]
  }
  const client = createAttachmentUploadClient(apiBase)
  const added: UserAttachment[] = []
  const attempted: string[] = []
  try {
    for (const file of files) {
      signal?.throwIfAborted()
      const uploadId = crypto.randomUUID()
      attempted.push(uploadId)
      added.push(await client.upload(file, uploadId, signal))
    }
    return [...current, ...added]
  } catch (error) {
    // A lost response can still have stored bytes. Revoke that fixed handle
    // too, without replaying the upload or disturbing the existing draft.
    const failures = await discardUploads(client, attempted)
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Attachment upload failed and some temporary files could not be removed.",
      )
    throw error
  }
}

export async function discardDraftAttachments(
  attachments: readonly UserAttachment[],
  apiBase = window.location.origin,
): Promise<void> {
  const client = createAttachmentUploadClient(apiBase)
  const uploadIds = [
    ...new Set(
      attachments.flatMap((attachment) => {
        const id = uploadIdFromAttachment(attachment)
        return id === undefined ? [] : [id]
      }),
    ),
  ]
  const native = attachments.filter(
    (attachment) => uploadIdFromAttachment(attachment) === undefined,
  )
  const failures: unknown[] = []
  // Invoke the native bridge synchronously, as editor disposal already expects.
  if (native.length && window.yakitoriDesktop !== undefined) {
    try {
      await window.yakitoriDesktop.discardDraftAttachments(native)
    } catch (error) {
      failures.push(error)
    }
  }
  failures.push(...(await discardUploads(client, uploadIds)))
  if (failures.length)
    throw new AggregateError(
      failures,
      "Some temporary attachments could not be removed.",
    )
}

// Cleanup shares the server's bounded upload capacity. Never fan out a draft's
// DELETEs, and try every handle even if one request fails.
async function discardUploads(
  client: ReturnType<typeof createAttachmentUploadClient>,
  uploadIds: readonly string[],
): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const uploadId of uploadIds) {
    try {
      await client.discard(uploadId)
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

export function attachmentUrl(
  attachment: UserAttachment,
  apiBase = window.location.origin,
): string {
  const url = rolloutAssetUrl(attachment.file, apiBase)
  if (url === undefined) throw new Error("Invalid attachment source.")
  return url
}

export function requireDesktopBridge(): YakitoriDesktopBridge {
  if (window.yakitoriDesktop === undefined) {
    throw new Error("Attachments require the Yakitori desktop app.")
  }
  return window.yakitoriDesktop
}
