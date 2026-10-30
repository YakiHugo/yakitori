export type ComputerPreviewTarget =
  | Readonly<{
      scope: "window"
      pid: number
      launchTime: number
      windowId: number
    }>
  | Readonly<{ scope: "app"; pid: number; launchTime: number }>
  | Readonly<{ scope: "screen"; displayId: number }>

export type ComputerPreviewCatalog = Readonly<{
  targets: readonly Readonly<{
    id: string
    label: string
    target: ComputerPreviewTarget
  }>[]
}>

export type ComputerPreviewFrame = Readonly<{
  dataUrl: string
  width: number
  height: number
  frame: Readonly<{ x: number; y: number; width: number; height: number }>
  pointer?: Readonly<{ x: number; y: number }>
  receivedAt: string
}>

export function parseComputerPreviewTarget(
  input: unknown,
): ComputerPreviewTarget {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("A preview target is required.")
  const value = input as Record<string, unknown>
  const positiveInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
  if (
    value.scope === "screen" &&
    positiveInteger(value.displayId) &&
    Object.keys(value).every((key) => ["scope", "displayId"].includes(key))
  )
    return { scope: "screen", displayId: value.displayId }
  if (
    (value.scope === "window" || value.scope === "app") &&
    positiveInteger(value.pid) &&
    typeof value.launchTime === "number" &&
    Number.isFinite(value.launchTime) &&
    value.launchTime > 0 &&
    Object.keys(value).every((key) =>
      [
        "scope",
        "pid",
        "launchTime",
        ...(value.scope === "window" ? ["windowId"] : []),
      ].includes(key),
    )
  ) {
    if (value.scope === "app")
      return { scope: "app", pid: value.pid, launchTime: value.launchTime }
    if (positiveInteger(value.windowId))
      return {
        scope: "window",
        pid: value.pid,
        launchTime: value.launchTime,
        windowId: value.windowId,
      }
  }
  throw new TypeError(
    "Preview requires an exact display ID or process incarnation and window ID.",
  )
}
