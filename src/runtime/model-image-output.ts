import {
  InvalidImageDataError,
  inspectImageBytes,
} from "../kernel/image-metadata.ts"
import { ATTACHMENT_FILE_SAFETY_BYTES } from "../protocol/attachment-upload.ts"
import type { ModelImageOutputBlock } from "../protocol/conversation.ts"

export function modelImageOutput(
  ProtocolError: new (message: string) => Error,
  data: unknown,
  declaredType?: unknown,
): ModelImageOutputBlock {
  // The upload boundary also bounds decoding of provider-supplied media.
  if (
    typeof data !== "string" ||
    data.length > Math.ceil(ATTACHMENT_FILE_SAFETY_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
  )
    throw new ProtocolError(
      "Provider image output is missing, too large, or invalid.",
    )
  const bytes = Buffer.from(data, "base64")
  if (bytes.length > ATTACHMENT_FILE_SAFETY_BYTES)
    throw new ProtocolError("Provider image output is too large to store.")
  let image: ReturnType<typeof inspectImageBytes>
  try {
    image = inspectImageBytes(bytes)
  } catch (error) {
    if (error instanceof InvalidImageDataError)
      throw new ProtocolError(error.message)
    throw error
  }
  const { mediaType } = image
  if (declaredType !== undefined && declaredType !== mediaType)
    throw new ProtocolError(
      "Provider image output does not match its declared type.",
    )
  return { type: "image_output", image: { type: "image", mediaType, data } }
}
