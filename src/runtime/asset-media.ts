import { type AssetSource, assetHttpUrl } from "../core/asset-types.ts"
import type { RolloutAssets } from "../core/rollout-assets.ts"
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
  const uploadedFiles = new Map<ModelDocumentBlock, string>()
  const messages: ModelMessage[] = []
  for (const message of request.messages) {
    if (message.role !== "user" && message.role !== "tool") {
      messages.push(message)
      continue
    }
    const content: ModelToolContentBlock[] = []
    for (const block of message.content) {
      if (block.type === "text" || block.data !== undefined) {
        content.push(block)
        continue
      }
      const source = block.file
      const url = "url" in source ? source.url : request.assets?.url?.(source)
      if (
        url !== undefined &&
        !(block.type === "image"
          ? options.inlineImageUrls
          : options.inlineDocumentUrls)
      ) {
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
      } else if (block.type === "image") {
        const prepared: ModelImageBlock = await prepareModelImage(
          bytes,
          block.detail ?? "high",
        )
        content.push(prepared)
      } else content.push({ ...block, data: bytes.toString("base64") })
    }
    messages.push({ ...message, content })
  }
  return { messages, uploadedFiles }
}
