import {
  changeWorkspaceGitIndex,
  listWorkspaceDirectory,
  readWorkspaceFile,
  readWorkspaceGitDiff,
  readWorkspaceGitStatus,
  WorkspaceError,
  type WorkspaceListResponse,
  type WorkspaceReadResponse,
  type GitDiffResponse,
  type GitStatusResponse,
} from "../workspace.ts"
import { INTERNAL_ERROR, INVALID_PARAMS } from "./messages.ts"
import { RpcMethodError, type RpcMethodDefinition } from "./methods.ts"

export type WorkspaceRpcParams = {
  "workspace/list": { cwd: string; path?: string }
  "workspace/read": {
    cwd: string
    path: string
    offset?: number
    limit?: number
  }
  "git/status": { cwd: string }
  "git/diff": { cwd: string; path: string; staged: boolean }
  "git/stage": { cwd: string; path: string }
  "git/unstage": { cwd: string; path: string }
}

export type WorkspaceRpcResponses = {
  "workspace/list": WorkspaceListResponse
  "workspace/read": WorkspaceReadResponse
  "git/status": GitStatusResponse
  "git/diff": GitDiffResponse
  "git/stage": Record<string, never>
  "git/unstage": Record<string, never>
}

function method(
  name: keyof WorkspaceRpcParams,
  invoke: (
    params: Record<string, unknown> & { cwd: string },
  ) => Promise<unknown>,
): RpcMethodDefinition {
  return {
    method: name,
    // Keep index reads consistent with user-initiated stage/unstage operations.
    scope: () =>
      name.startsWith("git/")
        ? { kind: "global", name: "workspace-git" }
        : undefined,
    async invoke(params) {
      try {
        if (
          typeof params !== "object" ||
          params === null ||
          Array.isArray(params)
        )
          throw new WorkspaceError("Expected workspace parameters.")
        if (!("cwd" in params) || typeof params.cwd !== "string")
          throw new WorkspaceError("cwd is required.")
        return {
          result: await invoke(
            params as Record<string, unknown> & { cwd: string },
          ),
        }
      } catch (error) {
        if (error instanceof WorkspaceError)
          throw new RpcMethodError(
            error.code === "invalid_input" ? INVALID_PARAMS : INTERNAL_ERROR,
            error.message,
            { code: error.code },
          )
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR")
          throw new RpcMethodError(
            INTERNAL_ERROR,
            "Workspace path does not exist.",
            { code: "not_found" },
          )
        if (code === "EACCES" || code === "EPERM")
          throw new RpcMethodError(
            INTERNAL_ERROR,
            "Workspace path cannot be accessed.",
            { code: "forbidden" },
          )
        throw error
      }
    },
  }
}

function path(params: Record<string, unknown>): string {
  if (typeof params.path !== "string")
    throw new WorkspaceError("path is required.")
  return params.path
}

export const workspaceRpcMethods: readonly RpcMethodDefinition[] = [
  method("workspace/list", (params) =>
    listWorkspaceDirectory({
      cwd: params.cwd,
      ...(params.path === undefined ? {} : { path: path(params) }),
    }),
  ),
  method("workspace/read", (params) => {
    if (params.offset !== undefined && typeof params.offset !== "number")
      throw new WorkspaceError("offset must be a number.")
    if (params.limit !== undefined && typeof params.limit !== "number")
      throw new WorkspaceError("limit must be a number.")
    return readWorkspaceFile({
      cwd: params.cwd,
      path: path(params),
      ...(params.offset === undefined ? {} : { offset: params.offset }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    })
  }),
  method("git/status", (params) => readWorkspaceGitStatus({ cwd: params.cwd })),
  method("git/diff", (params) => {
    if (typeof params.staged !== "boolean")
      throw new WorkspaceError("staged must be a boolean.")
    return readWorkspaceGitDiff({
      cwd: params.cwd,
      path: path(params),
      staged: params.staged,
    })
  }),
  ...(["git/stage", "git/unstage"] as const).map((name) =>
    method(name, async (params) => {
      await changeWorkspaceGitIndex({
        cwd: params.cwd,
        path: path(params),
        staged: name === "git/stage",
      })
      return {}
    }),
  ),
]
