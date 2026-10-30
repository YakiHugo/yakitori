import {
  type ComputerPreviewTarget,
  parseComputerPreviewTarget,
} from "../../protocol/computer-preview.ts"
import type { ComputerUseStatus } from "../../protocol/connections.ts"
import { McpConnectionError } from "../../runtime/mcp-client.ts"
import { ComputerControlError } from "../computer-control.ts"
import { ComputerPreviewError } from "../computer-preview.ts"
import {
  ComputerUseUnavailableError,
  connectComputerUse,
  disconnectComputerUse,
  readComputerUseStatus,
} from "../computer-use.ts"
import { INTERNAL_ERROR, INVALID_PARAMS } from "./messages.ts"
import { type RpcMethodDefinition, RpcMethodError } from "./methods.ts"

const connectionMethods: readonly RpcMethodDefinition[] = (
  [
    ["computer/status", readComputerUseStatus],
    ["computer/connect", connectComputerUse],
    ["computer/disconnect", disconnectComputerUse],
    ["computer/takeover", disconnectComputerUse],
  ] as const
).map(([method, operation]) => ({
  method,
  shutdownContinuation: method === "computer/takeover",
  // Urgent takeover must not wait behind a slow helper permission/status probe.
  scope: () =>
    method === "computer/takeover"
      ? undefined
      : { kind: "global" as const, name: "config" },
  async invoke(params, context) {
    const withControlState = (result: ComputerUseStatus): ComputerUseStatus => {
      const control = context.computerControl
      const owner = control?.owner
      return {
        ...result,
        ...(owner
          ? { inputOwner: { sessionId: owner.sessionId, turnId: owner.turnId } }
          : {}),
        ...(control?.admissionPaused ? { connected: false, tools: [] } : {}),
        ...(control?.takenOver ? { takenOver: true } : {}),
      }
    }
    if (
      params !== undefined &&
      (typeof params !== "object" ||
        params === null ||
        Array.isArray(params) ||
        Object.keys(params).length !== 0)
    ) {
      throw new RpcMethodError(
        INVALID_PARAMS,
        `${method} accepts an empty object.`,
      )
    }
    const config = context.userConfig
    if (config === undefined) {
      throw new RpcMethodError(
        INTERNAL_ERROR,
        "User configuration is unavailable.",
      )
    }
    if (method === "computer/takeover" && !context.computerControl)
      throw new RpcMethodError(
        INTERNAL_ERROR,
        "Computer control is unavailable.",
      )
    try {
      if (method === "computer/takeover") {
        await context.computerControl?.takeOver(async () => {
          await operation(config)
          await context.computerPreview?.stopAll()
        })
        const result = await readComputerUseStatus(config)
        return { result: withControlState(result) }
      }
      const epoch =
        method === "computer/connect"
          ? context.computerControl?.prepareResume()
          : undefined
      if (method === "computer/disconnect")
        context.computerControl?.disconnect()
      const result = await operation(config)
      if (method === "computer/disconnect")
        await context.computerPreview?.stopAll()
      if (epoch !== undefined) {
        try {
          context.computerControl?.resume(epoch)
        } catch (cause) {
          if (!(cause instanceof ComputerControlError)) throw cause
          // A connect already in flight must not undo a later takeover write.
          await disconnectComputerUse(config)
          throw cause
        }
      }
      return {
        result: withControlState(result),
      }
    } catch (error) {
      if (
        error instanceof ComputerUseUnavailableError ||
        error instanceof ComputerControlError ||
        error instanceof McpConnectionError
      ) {
        throw new RpcMethodError(INTERNAL_ERROR, error.message)
      }
      throw error
    }
  },
}))

const previewMethods: readonly RpcMethodDefinition[] = (
  ["catalog", "capture", "stop"] as const
).map((operation) => ({
  method: `computer/preview/${operation}`,
  shutdownContinuation: operation === "stop",
  scope: () => undefined,
  async invoke(params, context) {
    if (
      typeof params !== "object" ||
      params === null ||
      Array.isArray(params) ||
      !("viewerId" in params) ||
      typeof params.viewerId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(params.viewerId) ||
      Object.keys(params).some(
        (key) =>
          ![
            "viewerId",
            ...(operation === "capture" ? ["target"] : []),
          ].includes(key),
      )
    )
      throw new RpcMethodError(
        INVALID_PARAMS,
        "Preview requires viewerId and, for capture, one exact target.",
      )
    const service = context.computerPreview
    if (!service)
      throw new RpcMethodError(
        INTERNAL_ERROR,
        "Computer preview is unavailable.",
      )
    const owner = {
      connectionId: context.connectionId,
      viewerId: params.viewerId,
    }
    let target: ComputerPreviewTarget | undefined
    if (operation === "capture") {
      try {
        target = parseComputerPreviewTarget(
          "target" in params ? params.target : undefined,
        )
      } catch (cause) {
        if (cause instanceof TypeError)
          throw new RpcMethodError(INVALID_PARAMS, cause.message)
        throw cause
      }
    }
    try {
      if (operation === "stop") {
        await service.stop(owner)
        return { result: {} }
      }
      if (operation === "catalog")
        return { result: await service.catalog(owner) }
      if (!target) throw new Error("Capture target was not validated.")
      return { result: await service.capture(owner, target) }
    } catch (cause) {
      if (
        cause instanceof ComputerPreviewError ||
        cause instanceof McpConnectionError
      )
        throw new RpcMethodError(INTERNAL_ERROR, cause.message)
      throw cause
    }
  },
}))

export const computerMethods: readonly RpcMethodDefinition[] = [
  ...connectionMethods,
  ...previewMethods,
]
