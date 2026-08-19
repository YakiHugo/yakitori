import type { ImageAttachment } from "../kernel/events.ts"

export const MAX_COMPOSER_IMAGES = 4
export const MAX_COMPOSER_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_COMPOSER_IMAGES_BYTES = 10 * 1024 * 1024

export async function appendImageFiles(
  current: readonly ImageAttachment[],
  files: readonly File[],
): Promise<readonly ImageAttachment[]> {
  const candidates = files.filter((file) => file.type.startsWith("image/"))
  if (candidates.length !== files.length) {
    throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached.")
  }
  if (current.length + candidates.length > MAX_COMPOSER_IMAGES) {
    throw new Error(`Attach at most ${MAX_COMPOSER_IMAGES} images.`)
  }

  const added = await Promise.all(candidates.map(readImageFile))
  const attachments = [...current, ...added]
  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0,
  )
  if (totalBytes > MAX_COMPOSER_IMAGES_BYTES) {
    throw new Error("Attached images must be 10 MB or less in total.")
  }
  return attachments
}

export function imageAttachmentUrl(attachment: ImageAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`
}

async function readImageFile(file: File): Promise<ImageAttachment> {
  if (!isSupportedImageMediaType(file.type)) {
    throw new Error(`${file.name} is not a supported image type.`)
  }
  if (file.size === 0 || file.size > MAX_COMPOSER_IMAGE_BYTES) {
    throw new Error(`${file.name} must be smaller than 4 MB.`)
  }
  const url = await readFileAsDataUrl(file)
  const separator = url.indexOf(",")
  if (separator === -1) throw new Error(`${file.name} could not be read.`)
  return {
    name: file.name,
    mediaType: file.type,
    data: url.slice(separator + 1),
    sizeBytes: file.size,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result)
      else reject(new Error(`${file.name} could not be read.`))
    })
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error(`${file.name} could not be read.`))
    })
    reader.readAsDataURL(file)
  })
}

function isSupportedImageMediaType(
  value: string,
): value is ImageAttachment["mediaType"] {
  return (
    value === "image/gif" ||
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/webp"
  )
}
