import type { EffectiveModel } from "./effective-model.ts"

export const tencentVisionModel = "hy-vision-2.0-instruct"

// TokenHub lists this as a multimodal understanding model, not a function-
// calling model. This is a harness execution restriction, not an inferred
// vendor capability. Apply after editable/discovered metadata is merged.
// https://cloud.tencent.com/document/product/1823/130051
export function restrictTencentVision(model: EffectiveModel): EffectiveModel {
  if (model.model !== tencentVisionModel) return model
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
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    efforts: [],
    speeds: [],
    // 44k total is not the input allowance: TokenHub documents 24k input.
    contextWindowTokens: Math.min(model.contextWindowTokens ?? 24_000, 24_000),
    maxContextWindowTokens: Math.min(
      model.maxContextWindowTokens ?? 24_000,
      24_000,
    ),
    contextWindowScope: "input",
    effectiveContextWindowPercent: 100,
    maxOutputTokens: Math.min(model.maxOutputTokens ?? 16_000, 16_000),
    defaultOutputTokens: Math.min(
      model.defaultOutputTokens ?? 16_000,
      model.maxOutputTokens ?? 16_000,
      16_000,
    ),
  }
}
