import type { ResolvedModel } from "./model-catalog.ts"

type ModelEfforts = Pick<ResolvedModel, "efforts" | "defaultEffort">

export function mergeModelEfforts<
  T extends ModelEfforts & Readonly<{ model: string }>,
>(
  model: T,
  override: ModelEfforts,
  provider: string,
): Omit<T, keyof ModelEfforts> & ModelEfforts {
  const {
    efforts: inheritedEfforts,
    defaultEffort: inheritedDefault,
    ...base
  } = model
  const efforts = override.efforts ?? inheritedEfforts
  let defaultEffort = override.defaultEffort ?? inheritedDefault
  if (
    defaultEffort !== undefined &&
    efforts !== undefined &&
    !efforts.includes(defaultEffort)
  ) {
    if (override.defaultEffort !== undefined)
      throw new Error(
        `Default effort ${defaultEffort} is not supported by ${provider}/${model.model}.`,
      )
    defaultEffort = undefined
  }
  return {
    ...base,
    ...(efforts === undefined ? {} : { efforts }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
  }
}
