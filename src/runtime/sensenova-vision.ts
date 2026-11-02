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
  const {
    applyPatchToolType: _,
    defaultEffort: __,
    multiAgentReasoningEffort: ___,
    ...rest
  } = model
  return {
    ...rest,
    toolPolicy: "chat_only",
    instructions:
      "You are a text and image conversation assistant. Analyze only content supplied in this conversation. You cannot call tools, access workspace files, run commands, browse, or perform actions. Do not claim to have inspected, edited, or executed anything. You may explain code as text. Ask the user to provide missing content. If an action is needed, explain this limitation and ask them to switch to a tool-enabled model.",
    shellToolType: "disabled",
    fileEditingToolType: "none",
    supportsCustomTools: false,
    supportsNativeToolSearch: false,
    inputModalities:
      model.model === sensenovaVisionModel ? ["text", "image"] : ["text"],
    imageDetailModes: ["high"],
    efforts: [],
    speeds: [],
  }
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
