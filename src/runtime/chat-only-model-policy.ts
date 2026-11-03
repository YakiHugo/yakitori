import type { EffectiveModel } from "./effective-model.ts"

// Apply after configured/discovered facts. mergeEffectiveModel preserves these
// execution restrictions when later user settings are projected over the model.
export function restrictChatOnlyModel(
  model: EffectiveModel,
  inputModalities: EffectiveModel["inputModalities"],
): EffectiveModel {
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
    inputModalities,
    imageDetailModes: ["high"],
    efforts: [],
    speeds: [],
  }
}
