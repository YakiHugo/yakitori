import type { WorkspaceRpcParams } from "../../protocol/rpc-workspace.ts"

export type {
  WorkspaceRpcParams,
  WorkspaceRpcResponses,
} from "../../protocol/rpc-workspace.ts"

import {
  changeWorkspaceGitIndex,
  findWorkspaceFiles,
  listWorkspaceDirectory,
  readWorkspaceFile,
  readWorkspaceFileForEdit,
  readWorkspaceGitDiff,
  readWorkspaceGitStatus,
  readWorkspaceMediaFile,
  readWorkspaceOfficeFile,
  readWorkspacePullRequests,
  WorkspaceError,
  writeWorkspaceFile,
} from "../workspace.ts"
import { INTERNAL_ERROR, INVALID_PARAMS } from "./messages.ts"
import { type RpcMethodDefinition, RpcMethodError } from "./methods.ts"

function method(
  name: keyof WorkspaceRpcParams,
  invoke: (
    params: Record<string, unknown> & { cwd: string },
  ) => Promise<unknown>,
): RpcMethodDefinition {
  return {
    method: name,
    // Keep index reads consistent with user-initiated stage/unstage operations.
    // PR discovery is a remote lookup and does not touch the workspace index.
    scope: () =>
      name.startsWith("git/") && name !== "git/pullRequests"
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
  method("workspace/readMedia", (params) =>
    readWorkspaceMediaFile({ cwd: params.cwd, path: path(params) }),
  ),
  method("workspace/readOffice", (params) =>
    readWorkspaceOfficeFile({ cwd: params.cwd, path: path(params) }),
  ),
  method("workspace/readForEdit", (params) =>
    readWorkspaceFileForEdit({ cwd: params.cwd, path: path(params) }),
  ),
  method("workspace/write", (params) => {
    if (typeof params.content !== "string")
      throw new WorkspaceError("content is required.")
    if (typeof params.expectedSha256 !== "string")
      throw new WorkspaceError("expectedSha256 is required.")
    if (
      Object.keys(params).some(
        (key) =>
          key !== "cwd" &&
          key !== "path" &&
          key !== "content" &&
          key !== "expectedSha256",
      )
    )
      throw new WorkspaceError("Unexpected workspace/write parameter.")
    return writeWorkspaceFile({
      cwd: params.cwd,
      path: path(params),
      content: params.content,
      expectedSha256: params.expectedSha256,
    })
  }),
  method("workspace/findFiles", (params) => {
    if (typeof params.query !== "string")
      throw new WorkspaceError("query is required.")
    if (params.limit !== undefined && typeof params.limit !== "number")
      throw new WorkspaceError("limit must be a number.")
    return findWorkspaceFiles({
      cwd: params.cwd,
      query: params.query,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    })
  }),
  method("git/status", (params) => readWorkspaceGitStatus({ cwd: params.cwd })),
  method("git/pullRequests", (params) => {
    if (typeof params.branch !== "string")
      throw new WorkspaceError("branch is required.")
    return readWorkspacePullRequests({
      cwd: params.cwd,
      branch: params.branch,
    })
  }),
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
