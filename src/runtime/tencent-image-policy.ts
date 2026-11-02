import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { AssetMediaError } from "./asset-media.ts"
import { jsonRequestByteLength } from "./json-request-budget.ts"
import type { ModelImageBlock } from "./model.ts"
import { validateModelImage } from "./prepare-model-image.ts"

// https://cloud.tencent.cn/document/product/1823/136956
// 10 MB/image is a recommendation, not a hard quota. The shared media loader's
// resource-safety bound still applies. Validate and send original bytes.
const requestLimit = 100_000_000
export function createTencentImagePolicy(signal?: AbortSignal) {
  let encodedBytes = 0
  return {
    async prepareImage(
      bytes: Buffer,
      image: ModelImageBlock,
    ): Promise<ModelImageBlock> {
      if (image.detail === "original")
        throw new AssetMediaError(
          "TokenHub does not document an original-detail request mode. The original image has not been changed.",
        )
      const metadata = inspectImageBytes(bytes)
      if (
        !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          metadata.mediaType,
        )
      )
        throw new AssetMediaError(
          "TokenHub images must be JPEG, PNG, GIF or WebP. The original image has not been changed.",
        )
      encodedBytes += 4 * Math.ceil(bytes.length / 3)
      if (encodedBytes > requestLimit)
        throw new AssetMediaError(
          "TokenHub encoded images exceed the 100 MB request limit. Send fewer images; originals have not been changed.",
        )
      await validateModelImage(bytes, signal)
      return {
        type: "image",
        mediaType: metadata.mediaType,
        data: bytes.toString("base64"),
      }
    },
    validateBody(body: unknown) {
      if (jsonRequestByteLength(body, requestLimit) === undefined)
        throw new AssetMediaError(
          "TokenHub request exceeds 100 MB including text and encoded images. Send less content; originals have not been changed.",
        )
    },
  }
}
