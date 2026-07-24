export const InputState = {
  Admitted: "admitted",
  Promoted: "promoted",
  Cancelled: "cancelled",
} as const

export const TurnState = {
  Started: "started",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
} as const

export const PermissionState = {
  Pending: "pending",
  Resolved: "resolved",
} as const

export const ToolState = {
  Requested: "requested",
  Completed: "completed",
  Failed: "failed",
} as const

export type InputState = (typeof InputState)[keyof typeof InputState]
export type TurnState = (typeof TurnState)[keyof typeof TurnState]
export type PermissionState =
  (typeof PermissionState)[keyof typeof PermissionState]
export type ToolState = (typeof ToolState)[keyof typeof ToolState]
