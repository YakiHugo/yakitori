import { type AssetSource, assetHttpUrl } from "../core/asset-types.ts"
import type { RolloutAssets } from "../core/rollout-assets.ts"
import { InvalidImageDataError } from "../kernel/image-metadata.ts"
import type {
  ModelDocumentBlock,
  ModelImageBlock,
  ModelMessage,
  ModelRequest,
  ModelToolContentBlock,
} from "./model.ts"
import { prepareModelImage } from "./prepare-model-image.ts"

// Match local attachment snapshot safety: remote reads must not allocate an
// unbounded body merely because a backend needs inline media.
export class AssetMediaError extends Error {}

const ASSET_READ_SAFETY_BYTES = 50_000_000

export async function readAssetSource(
  source: AssetSource,
  assets: RolloutAssets | undefined,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted()
  if (!("url" in source)) {
    if (assets === undefined)
      throw new AssetMediaError("Rollout asset storage is unavailable.")
    return assets.read(source)
  }
  const url = assetHttpUrl(source.url)
  if (url === undefined)
    throw new AssetMediaError(
      "Asset URL must be an HTTP(S) address without credentials.",
    )
  const response = await fetch(
    url,
    signal === undefined ? undefined : { signal },
  )
  if (!response.ok)
    throw new AssetMediaError(
      `Asset request failed with HTTP ${response.status}.`,
    )
  if (!response.body) throw new AssetMediaError("Asset response has no body.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > ASSET_READ_SAFETY_BYTES)
        throw new AssetMediaError(
          "Asset response exceeds the 50 MB read safety boundary.",
        )
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks, size)
}

// Each provider invokes preparation at its wire boundary. The durable message
// remains portable; uploaded IDs exist only in this provider-local lookup.
export async function prepareProviderMedia(
  request: ModelRequest,
  options: Readonly<{
    prepareImage?(
      bytes: Buffer,
      image: ModelImageBlock,
    ): Promise<ModelImageBlock>
    inlineImageUrls?: boolean
    inlineDocumentUrls?: boolean
    uploadDocument?(
      document: ModelDocumentBlock,
      bytes: Buffer,
    ): Promise<string>
  }> = {},
): Promise<{
  messages: readonly ModelMessage[]
  uploadedFiles: ReadonlyMap<ModelDocumentBlock, string>
}> {
  request.signal?.throwIfAborted()
  const uploadedFiles = new Map<ModelDocumentBlock, string>()
  const preparedImages = new Map<ModelImageBlock, ModelImageBlock>()
  // A compatibility endpoint has no verified API budget. Bound only our local
  // retained base64 image data, including repeat occurrences in history. This
  // allows one 50 MB attachment, not an unbounded batch, and is NOT a wire quota.
  const genericImageSafetyBytes = 80 * 1024 * 1024
  let genericImageBytes = 0
  const prepareImage =
    options.prepareImage ??
    (async (bytes, image) => {
      const prepared = await prepareModelImage(
        bytes,
        image.detail ?? "high",
        request.signal,
      )
      genericImageBytes += prepared.data?.length ?? 0
      if (genericImageBytes > genericImageSafetyBytes)
        throw new AssetMediaError(
          "Images were not sent: exceeds Yakitori's 80 MiB local compatibility image-data budget. Send fewer images or export smaller copies; originals have not been changed.",
        )
      return prepared
    })
  if (options.prepareImage === undefined) {
    let inlineBytes = 0
    for (const message of request.messages) {
      if (message.role !== "user" && message.role !== "tool") continue
      for (const block of message.content) {
        if (block.type === "image" && block.data !== undefined)
          inlineBytes += block.data.length
        if (inlineBytes > genericImageSafetyBytes)
          throw new AssetMediaError(
            "Images were not sent: exceeds Yakitori's 80 MiB local compatibility image-data budget. Send fewer images or export smaller copies; originals have not been changed.",
          )
      }
    }
  }
  // Validate every locally available image before any document upload. This
  // includes inline images passed directly to a provider, outside the Turn
  // projection. External URLs retain their provider-owned fetch semantics.
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role !== "user" && message.role !== "tool") continue
    for (const [contentIndex, block] of message.content.entries()) {
      request.signal?.throwIfAborted()
      if (block.type !== "image") continue
      try {
        if (block.data !== undefined) {
          const bytes = Buffer.from(block.data, "base64")
          preparedImages.set(block, await prepareImage(bytes, block))
          continue
        }
        const source = block.file
        const url = "url" in source ? source.url : request.assets?.url?.(source)
        if (url !== undefined && !options.inlineImageUrls) {
          preparedImages.set(block, { ...block, file: { url } })
          continue
        }
        const bytes = request.assets
          ? await request.assets.read(source, request.signal)
          : await readAssetSource(source, undefined, request.signal)
        if (block.sizeBytes > 0 && bytes.length !== block.sizeBytes)
          throw new AssetMediaError(
            "Asset size does not match its recorded size.",
          )
        preparedImages.set(block, await prepareImage(bytes, block))
      } catch (cause) {
        if (cause instanceof InvalidImageDataError) {
          const source =
            block.data === undefined && "path" in block.file
              ? ` (${block.file.path})`
              : ""
          throw new AssetMediaError(
            `Image in ${message.role} message ${messageIndex + 1}, part ${contentIndex + 1}${source}: ${cause.message}`,
            { cause },
          )
        }
        throw cause
      }
    }
  }
  const messages: ModelMessage[] = []
  for (const message of request.messages) {
    if (message.role !== "user" && message.role !== "tool") {
      messages.push(message)
      continue
    }
    const content: ModelToolContentBlock[] = []
    for (const block of message.content) {
      request.signal?.throwIfAborted()
      if (block.type === "image") {
        content.push(preparedImages.get(block) ?? block)
        continue
      }
      if (block.type === "text" || block.data !== undefined) {
        content.push(block)
        continue
      }
      const source = block.file
      const url = "url" in source ? source.url : request.assets?.url?.(source)
      if (url !== undefined && !options.inlineDocumentUrls) {
        content.push({ ...block, file: { url } })
        continue
      }
      const bytes = request.assets
        ? await request.assets.read(source, request.signal)
        : await readAssetSource(source, undefined, request.signal)
      if (block.sizeBytes > 0 && bytes.length !== block.sizeBytes)
        throw new AssetMediaError(
          "Asset size does not match its recorded size.",
        )
      if (block.type === "document" && options.uploadDocument) {
        uploadedFiles.set(block, await options.uploadDocument(block, bytes))
        content.push(block)
      } else content.push({ ...block, data: bytes.toString("base64") })
    }
    messages.push({ ...message, content })
  }
  return { messages, uploadedFiles }
}
