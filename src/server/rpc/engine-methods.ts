import { realpath, stat } from "node:fs/promises"
import { EngineRegistryError, type EngineRegistry } from "../engine-registry.ts"
import { INVALID_PARAMS, METHOD_NOT_FOUND } from "./messages.ts"
import { type RpcMethodDefinition, RpcMethodError } from "./methods.ts"
import type { EngineRpcParams } from "../../protocol/engine.ts"

function string(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== "string" || !value.trim())
    throw new EngineRegistryError(`${key} must be a nonempty string.`)
  return value
}

function optional(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  return params[key] === undefined ? undefined : string(params, key)
}

function entry(
  method: keyof EngineRpcParams,
  invoke: (
    registry: EngineRegistry,
    params: Record<string, unknown>,
  ) => unknown,
): RpcMethodDefinition {
  return {
    method,
    shutdownContinuation:
      method === "engineSession/cancel" ||
      method === "engineSession/respondPermission",
    // A pending prompt must not serialize away the cancel/permission response
    // needed to release it. The durable service owns admission idempotency.
    scope: () => undefined,
    async invoke(params, context) {
      if (!context.engines)
        throw new RpcMethodError(
          METHOD_NOT_FOUND,
          "External engines are unavailable.",
        )
      try {
        if (
          typeof params !== "object" ||
          params === null ||
          Array.isArray(params)
        )
          throw new EngineRegistryError("Expected engine parameters.")
        return {
          result: await invoke(
            context.engines,
            params as Record<string, unknown>,
          ),
        }
      } catch (error) {
        if (error instanceof EngineRegistryError)
          throw new RpcMethodError(INVALID_PARAMS, error.message)
        throw error
      }
    },
  }
}

export const engineMethods: readonly RpcMethodDefinition[] = [
  entry("engine/list", (registry) => ({ engines: registry.engines() })),
  entry("engineSession/list", (registry) => ({ sessions: registry.list() })),
  entry("engineSession/create", async (registry, params) => {
    const cwd = optional(params, "cwd")
    let resolved: string | undefined
    if (cwd !== undefined) {
      try {
        resolved = await realpath(cwd)
        if (!(await stat(resolved)).isDirectory())
          throw new EngineRegistryError(
            "Working directory must be a directory.",
          )
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ENOTDIR"
        )
          throw new EngineRegistryError("Working directory does not exist.")
        throw error
      }
    }
    const title = optional(params, "title")
    const projectId = optional(params, "projectId")
    return registry.create({
      engineId: string(params, "engineId"),
      ...(resolved === undefined ? {} : { cwd: resolved }),
      ...(title === undefined ? {} : { title }),
      ...(projectId === undefined ? {} : { projectId }),
    })
  }),
  entry("engineSession/read", (registry, params) =>
    registry.read(string(params, "sessionId")),
  ),
  entry("engineSession/send", (registry, params) =>
    registry.send({
      sessionId: string(params, "sessionId"),
      requestId: string(params, "requestId"),
      text: string(params, "text"),
    }),
  ),
  entry("engineSession/cancel", (registry, params) =>
    registry.cancel({
      sessionId: string(params, "sessionId"),
      turnId: string(params, "turnId"),
    }),
  ),
  entry("engineSession/respondPermission", (registry, params) => {
    const turnId = optional(params, "turnId")
    return registry.respondPermission({
      sessionId: string(params, "sessionId"),
      requestId: string(params, "requestId"),
      optionId: string(params, "optionId"),
      ...(turnId === undefined ? {} : { turnId }),
    })
  }),
]
