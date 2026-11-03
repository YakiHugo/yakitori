import type { ConfiguredModel } from "../protocol/providers.ts"

// Reported/configured facts override preset defaults. An explicit effort list,
// including [], may retire an inherited default; a missing list does not.
// Keep an explicitly supplied default for the configuration boundary to validate.
export function configuredModelWithDefaults(
  model: ConfiguredModel,
  defaults: ConfiguredModel | undefined,
): ConfiguredModel {
  const { defaultEffort, ...known } = defaults ?? {}
  return {
    ...known,
    ...(defaultEffort !== undefined &&
    (model.efforts === undefined || model.efforts.includes(defaultEffort))
      ? { defaultEffort }
      : {}),
    ...model,
  }
}
