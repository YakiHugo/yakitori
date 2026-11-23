import { isJsonObject } from "./json.ts"

export type AcpConfigControl = Readonly<{
  id: string
  kind: "config" | "mode" | "model"
  label: string
  value: string
  options: readonly Readonly<{
    value: string
    label: string
    group?: Readonly<{ id: string; label: string }>
  }>[]
}>

export function applyAcpConfig(
  current: readonly AcpConfigControl[],
  update: Record<string, unknown>,
): readonly AcpConfigControl[] {
  if (Array.isArray(update.configOptions)) {
    return update.configOptions.flatMap((value): AcpConfigControl[] => {
      if (
        !isJsonObject(value) ||
        value.type !== "select" ||
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.currentValue !== "string" ||
        !Array.isArray(value.options)
      )
        return []
      const options = value.options.flatMap((option) =>
        isJsonObject(option) &&
        Array.isArray(option.options) &&
        typeof option.group === "string" &&
        typeof option.name === "string"
          ? parseOptions(option.options, {
              id: option.group,
              label: option.name,
            })
          : parseOptions([option]),
      )
      return options.length === 0
        ? []
        : [
            {
              id: value.id,
              kind: "config",
              label: value.name,
              value: value.currentValue,
              options,
            },
          ]
    })
  }
  if (update.sessionUpdate === "session_initialized")
    return [
      ...legacyControl("mode", "Mode", update.modes),
      ...legacyControl("model", "Model", update.models),
    ]
  if (
    update.sessionUpdate === "current_mode_update" &&
    typeof update.currentModeId === "string"
  ) {
    const value = update.currentModeId
    return current.map((control) =>
      control.kind === "mode" ? { ...control, value } : control,
    )
  }
  if (
    update.sessionUpdate === "current_model_update" &&
    typeof update.currentModelId === "string"
  ) {
    const value = update.currentModelId
    return current.map((control) =>
      control.kind === "model" ? { ...control, value } : control,
    )
  }
  return current
}

function parseOptions(
  input: readonly unknown[],
  group?: AcpConfigControl["options"][number]["group"],
): AcpConfigControl["options"] {
  return input.flatMap((option) =>
    isJsonObject(option) &&
    typeof option.value === "string" &&
    typeof option.name === "string"
      ? [
          {
            value: option.value,
            label: option.name,
            ...(group === undefined ? {} : { group }),
          },
        ]
      : [],
  )
}

function legacyControl(
  kind: "mode" | "model",
  label: string,
  value: unknown,
): AcpConfigControl[] {
  if (!isJsonObject(value)) return []
  const choice = kind === "mode" ? value.currentModeId : value.currentModelId
  const values = kind === "mode" ? value.availableModes : value.availableModels
  if (typeof choice !== "string" || !Array.isArray(values)) return []
  const options = values.flatMap((option) => {
    if (!isJsonObject(option) || typeof option.name !== "string") return []
    const id = kind === "model" ? (option.modelId ?? option.id) : option.id
    return typeof id === "string" ? [{ value: id, label: option.name }] : []
  })
  return options.length === 0
    ? []
    : [{ id: kind, kind, label, value: choice, options }]
}
