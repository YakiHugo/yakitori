import {
  ComputerUseUnavailableError,
  connectComputerUse,
  disconnectComputerUse,
  readComputerUseStatus,
} from "../computer-use.ts"
import { McpConnectionError } from "../../runtime/mcp-client.ts"
import { INTERNAL_ERROR, INVALID_PARAMS } from "./messages.ts"
import { RpcMethodError, type RpcMethodDefinition } from "./methods.ts"

export const computerMethods: readonly RpcMethodDefinition[] = (
  [
    ["computer/status", readComputerUseStatus],
    ["computer/connect", connectComputerUse],
    ["computer/disconnect", disconnectComputerUse],
  ] as const
).map(([method, operation]) => ({
  method,
  scope: () => ({ kind: "global" as const, name: "config" }),
  async invoke(params, context) {
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
    if (context.userConfig === undefined) {
      throw new RpcMethodError(
        INTERNAL_ERROR,
        "User configuration is unavailable.",
      )
    }
    try {
      return {
        result: await operation(context.userConfig),
      }
    } catch (error) {
      if (
        error instanceof ComputerUseUnavailableError ||
        error instanceof McpConnectionError
      ) {
        throw new RpcMethodError(INTERNAL_ERROR, error.message)
      }
      throw error
    }
  },
}))
