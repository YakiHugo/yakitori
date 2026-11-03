import { restrictChatOnlyModel } from "./chat-only-model-policy.ts"
import type { EffectiveModel } from "./effective-model.ts"
import type { ModelImageBlock } from "./model.ts"
import { AssetMediaError } from "./asset-media.ts"
import { inspectImageBytes } from "../kernel/image-metadata.ts"
import { validateModelImage } from "./prepare-model-image.ts"

export const sensenovaVisionModel = "sensenova-6.8-flash-lite"

export function isSenseNovaEndpoint(baseURL: string): boolean {
  return [
    "https://token.sensenova.cn/v1",
    "https://token.sensenova.ai/v1",
  ].includes(URL.parse(baseURL)?.href.replace(/\/$/, "") ?? "")
}

// Official 6.8 API.md establishes image chat, not a complete tools contract.
// This is a conservative harness restriction, not a claim the model lacks tools.
// https://github.com/OpenSenseNova/SenseNova6.8/blob/main/API.md
export function restrictSenseNovaVision(model: EffectiveModel): EffectiveModel {
  return restrictChatOnlyModel(
    model,
    model.model === sensenovaVisionModel ? ["text", "image"] : ["text"],
  )
}

export async function prepareSenseNovaImage(
  bytes: Buffer,
  _image: ModelImageBlock,
  signal?: AbortSignal,
): Promise<ModelImageBlock> {
  const metadata = inspectImageBytes(bytes)
  if (!["image/jpeg", "image/png"].includes(metadata.mediaType))
    throw new AssetMediaError(
      "SenseNova image chat currently admits documented JPEG and PNG input only. Export a copy; the original has not been changed.",
    )
  await validateModelImage(bytes, signal)
  // The official 2048px advice is an optimization, not an admission limit.
  // Preserve originals; shared media loading/decoder safety bounds still apply.
  return {
    type: "image",
    mediaType: metadata.mediaType,
    data: bytes.toString("base64"),
  }
}
