import { createYakitoriError, YakitoriErrorCode } from "./errors.ts"
import {
  ItemStatus,
  PermissionBehavior,
  type EventMetadata,
} from "./events.ts"

export const InputState = {
  Admitted: "admitted",
  Cancelled: "cancelled",
  Promoted: "promoted",
} as const

export const TurnState = {
  Cancelled: "cancelled",
  Completed: "completed",
  Failed: "failed",
  Started: "started",
} as const

export const PermissionState = {
  Cancelled: "cancelled",
  Requested: "requested",
  Resolved: "resolved",
} as const

export const ToolState = {
  Cancelled: "cancelled",
  Completed: "completed",
  Failed: "failed",
  Requested: "requested",
  Started: "started",
} as const

export type InputState = (typeof InputState)[keyof typeof InputState]
export type TurnState = (typeof TurnState)[keyof typeof TurnState]
export type PermissionState =
  (typeof PermissionState)[keyof typeof PermissionState]
export type ToolState = (typeof ToolState)[keyof typeof ToolState]

export type GuardErrors = {
  notFound(message: string, details?: EventMetadata): Error
  invalidArgument(message: string, details?: EventMetadata): Error
  invalidState(message: string, details?: EventMetadata): Error
}

export type GuardInput = {
  readonly inputId: string
  readonly state: InputState
  readonly turnId?: string
}

export type GuardTurn = {
  readonly turnId: string
  readonly state: TurnState
}

export type GuardItem = {
  readonly itemId: string
  readonly turnId: string
  readonly status: (typeof ItemStatus)[keyof typeof ItemStatus]
}

export type GuardPermission = {
  readonly permissionRequestId: string
  readonly turnId: string
  readonly state: PermissionState
  readonly toolCallId?: string
  readonly behavior?: (typeof PermissionBehavior)[keyof typeof PermissionBehavior]
}

export type GuardTool = {
  readonly toolCallId: string
  readonly turnId: string
  readonly state: ToolState
  readonly permissionRequestId?: string
}

export const commandGuardErrors: GuardErrors = {
  notFound(message, details) {
    return createYakitoriError({
      code: YakitoriErrorCode.NotFound,
      message,
      ...(details === undefined ? {} : { details }),
    })
  },
  invalidArgument(message, details) {
    return createYakitoriError({
      code: YakitoriErrorCode.InvalidArgument,
      message,
      ...(details === undefined ? {} : { details }),
    })
  },
  invalidState(message, details) {
    return createYakitoriError({
      code: YakitoriErrorCode.InvalidState,
      message,
      ...(details === undefined ? {} : { details }),
    })
  },
}

export const replayGuardErrors: GuardErrors = {
  notFound: invalidReplay,
  invalidArgument: invalidReplay,
  invalidState: invalidReplay,
}

function invalidReplay(message: string, details?: EventMetadata): Error {
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidReplay,
    message,
    ...(details === undefined ? {} : { details }),
  })
}

export function requireInput<T extends GuardInput>(
  input: T | undefined,
  inputId: string,
  errors: GuardErrors,
): T {
  if (input) return input
  throw errors.notFound(`Input ${inputId} has not been admitted.`, {
    inputId,
  })
}

export function requireTurn<T extends GuardTurn>(
  turn: T | undefined,
  turnId: string,
  errors: GuardErrors,
): T {
  if (turn) return turn
  throw errors.notFound(`Turn ${turnId} has not been started.`, {
    turnId,
  })
}

export function requireItem<T extends GuardItem>(
  item: T | undefined,
  turnId: string,
  itemId: string,
  errors: GuardErrors,
): T {
  if (!item) {
    throw errors.notFound(`Item ${itemId} has not been appended.`, {
      itemId,
    })
  }
  if (item.turnId === turnId) return item
  throw errors.invalidArgument(
    `Item ${itemId} does not belong to turn ${turnId}.`,
    {
      itemId,
      turnId,
      actualTurnId: item.turnId,
    },
  )
}

export function requireActiveItem<T extends GuardItem>(
  item: T | undefined,
  turnId: string,
  itemId: string,
  errors: GuardErrors,
): T {
  const found = requireItem(item, turnId, itemId, errors)
  if (found.status === ItemStatus.InProgress) return found
  throw errors.invalidState(`Item ${itemId} is already ${found.status}.`, {
    itemId,
    status: found.status,
  })
}

export function requireCompletedItem<T extends GuardItem>(
  item: T | undefined,
  turnId: string,
  itemId: string,
  errors: GuardErrors,
): T {
  const found = requireItem(item, turnId, itemId, errors)
  if (found.status === ItemStatus.Completed) return found
  throw errors.invalidState(`Item ${itemId} is ${found.status}.`, {
    itemId,
    status: found.status,
  })
}

export function requirePermission<T extends GuardPermission>(
  permission: T | undefined,
  turnId: string,
  permissionRequestId: string,
  errors: GuardErrors,
): T {
  if (!permission) {
    throw errors.notFound(
      `Permission ${permissionRequestId} has not been requested.`,
      {
        permissionRequestId,
      },
    )
  }
  if (permission.turnId === turnId) return permission
  throw errors.invalidArgument(
    `Permission ${permissionRequestId} does not belong to turn ${turnId}.`,
    {
      permissionRequestId,
      turnId,
      actualTurnId: permission.turnId,
    },
  )
}

/**
 * A tool may bind a permission only while it is usable: still `requested`,
 * or already resolved-allow. Resolved-deny and cancelled permissions cannot
 * be bound. One permission binds to at most one tool (`toolCallId`).
 */
export function requireBindablePermission<T extends GuardPermission>(
  permission: T | undefined,
  turnId: string,
  permissionRequestId: string,
  errors: GuardErrors,
): T {
  const found = requirePermission(
    permission,
    turnId,
    permissionRequestId,
    errors,
  )
  if (found.toolCallId !== undefined) {
    throw errors.invalidState(
      `Permission ${permissionRequestId} is already bound to tool ${found.toolCallId}.`,
      {
        permissionRequestId,
        toolCallId: found.toolCallId,
      },
    )
  }
  if (found.state === PermissionState.Requested) return found
  if (
    found.state === PermissionState.Resolved &&
    found.behavior === PermissionBehavior.Allow
  ) {
    return found
  }
  if (found.state === PermissionState.Resolved) {
    throw errors.invalidState(
      `Permission ${permissionRequestId} resolved with ${found.behavior}.`,
      {
        permissionRequestId,
        behavior: found.behavior ?? null,
      },
    )
  }
  throw errors.invalidState(
    `Permission ${permissionRequestId} is already ${found.state}.`,
    {
      permissionRequestId,
      state: found.state,
    },
  )
}

export function requirePendingPermission<T extends GuardPermission>(
  permission: T | undefined,
  turnId: string,
  permissionRequestId: string,
  errors: GuardErrors,
): T {
  const found = requirePermission(
    permission,
    turnId,
    permissionRequestId,
    errors,
  )
  if (found.state === PermissionState.Requested) return found
  throw errors.invalidState(
    `Permission ${permissionRequestId} is already ${found.state}.`,
    {
      permissionRequestId,
      state: found.state,
    },
  )
}

export function requireAllowedPermission<T extends GuardPermission>(
  permission: T | undefined,
  turnId: string,
  permissionRequestId: string,
  errors: GuardErrors,
): T {
  const found = requirePermission(
    permission,
    turnId,
    permissionRequestId,
    errors,
  )
  if (
    found.state === PermissionState.Resolved &&
    found.behavior === PermissionBehavior.Allow
  ) {
    return found
  }
  if (found.state === PermissionState.Resolved) {
    throw errors.invalidState(
      `Permission ${permissionRequestId} resolved with ${found.behavior}.`,
      {
        permissionRequestId,
        behavior: found.behavior ?? null,
      },
    )
  }
  throw errors.invalidState(
    `Permission ${permissionRequestId} has not been allowed.`,
    {
      permissionRequestId,
      state: found.state,
    },
  )
}

export function requireAllowedToolPermissions(
  permissions: Iterable<GuardPermission>,
  turnId: string,
  tool: GuardTool,
  errors: GuardErrors,
): void {
  for (const permission of permissions) {
    if (permission.turnId !== turnId) continue
    if (
      permission.permissionRequestId !== tool.permissionRequestId &&
      permission.toolCallId !== tool.toolCallId
    ) {
      continue
    }
    requireAllowedPermission(
      permission,
      turnId,
      permission.permissionRequestId,
      errors,
    )
  }
}

export function requireTool<T extends GuardTool>(
  tool: T | undefined,
  turnId: string,
  toolCallId: string,
  errors: GuardErrors,
): T {
  if (!tool) {
    throw errors.notFound(`Tool ${toolCallId} has not been requested.`, {
      toolCallId,
    })
  }
  if (tool.turnId === turnId) return tool
  throw errors.invalidArgument(
    `Tool ${toolCallId} does not belong to turn ${turnId}.`,
    {
      toolCallId,
      turnId,
      actualTurnId: tool.turnId,
    },
  )
}

export function requireRequestedTool<T extends GuardTool>(
  tool: T | undefined,
  turnId: string,
  toolCallId: string,
  errors: GuardErrors,
): T {
  const found = requireTool(tool, turnId, toolCallId, errors)
  if (found.state === ToolState.Requested) return found
  throw errors.invalidState(`Tool ${toolCallId} is already ${found.state}.`, {
    toolCallId,
    state: found.state,
  })
}

export function requireStartedTool<T extends GuardTool>(
  tool: T | undefined,
  turnId: string,
  toolCallId: string,
  errors: GuardErrors,
): T {
  const found = requireTool(tool, turnId, toolCallId, errors)
  if (found.state === ToolState.Started) return found
  throw errors.invalidState(`Tool ${toolCallId} is already ${found.state}.`, {
    toolCallId,
    state: found.state,
  })
}

export function requireOpenTool<T extends GuardTool>(
  tool: T | undefined,
  turnId: string,
  toolCallId: string,
  errors: GuardErrors,
): T {
  const found = requireTool(tool, turnId, toolCallId, errors)
  if (found.state === ToolState.Requested || found.state === ToolState.Started) {
    return found
  }
  throw errors.invalidState(`Tool ${toolCallId} is already ${found.state}.`, {
    toolCallId,
    state: found.state,
  })
}

export function requireNoOpenTurnWork(
  items: Iterable<GuardItem>,
  permissions: Iterable<GuardPermission>,
  tools: Iterable<GuardTool>,
  turnId: string,
  errors: GuardErrors,
): void {
  for (const item of items) {
    if (item.turnId !== turnId || item.status !== ItemStatus.InProgress) {
      continue
    }
    throw errors.invalidState(`Turn ${turnId} has open item ${item.itemId}.`, {
      turnId,
      itemId: item.itemId,
    })
  }

  for (const permission of permissions) {
    if (
      permission.turnId !== turnId ||
      permission.state !== PermissionState.Requested
    ) {
      continue
    }
    throw errors.invalidState(
      `Turn ${turnId} has pending permission ${permission.permissionRequestId}.`,
      {
        turnId,
        permissionRequestId: permission.permissionRequestId,
      },
    )
  }

  for (const tool of tools) {
    if (
      tool.turnId !== turnId ||
      (tool.state !== ToolState.Requested && tool.state !== ToolState.Started)
    ) {
      continue
    }
    throw errors.invalidState(`Turn ${turnId} has open tool ${tool.toolCallId}.`, {
      turnId,
      toolCallId: tool.toolCallId,
    })
  }
}

export function requireActiveTurn<T extends GuardTurn>(
  turn: T | undefined,
  turnId: string,
  errors: GuardErrors,
): T {
  const found = requireTurn(turn, turnId, errors)
  if (found.state === TurnState.Started) return found
  throw errors.invalidState(`Turn ${turnId} is already ${found.state}.`, {
    turnId,
    state: found.state,
  })
}

export function requireNoActiveTurn(
  turns: Iterable<GuardTurn>,
  errors: GuardErrors,
  sessionId?: string,
): void {
  for (const turn of turns) {
    if (turn.state !== TurnState.Started) continue
    throw errors.invalidState(
      sessionId === undefined
        ? `Session already has active turn ${turn.turnId}.`
        : `Session ${sessionId} already has active turn ${turn.turnId}.`,
      {
        ...(sessionId === undefined ? {} : { sessionId }),
        turnId: turn.turnId,
      },
    )
  }
}
