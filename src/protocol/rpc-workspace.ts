import type {
  GitDiffResponse,
  GitPullRequestsResponse,
  GitStatusResponse,
  WorkspaceFindFilesResponse,
  WorkspaceListResponse,
  WorkspaceReadForEditResponse,
  WorkspaceReadMediaResponse,
  WorkspaceReadOfficeResponse,
  WorkspaceReadResponse,
  WorkspaceWriteResponse,
} from "./workspace.ts"
export type WorkspaceRpcParams = {
  "workspace/list": { cwd: string; path?: string }
  "workspace/read": {
    cwd: string
    path: string
    offset?: number
    limit?: number
  }
  "workspace/readMedia": { cwd: string; path: string }
  "workspace/readOffice": { cwd: string; path: string }
  "workspace/readForEdit": { cwd: string; path: string }
  "workspace/write": {
    cwd: string
    path: string
    content: string
    expectedSha256: string
  }
  "workspace/findFiles": { cwd: string; query: string; limit?: number }
  "git/status": { cwd: string }
  "git/pullRequests": { cwd: string; branch: string }
  "git/diff": { cwd: string; path: string; staged: boolean }
  "git/stage": { cwd: string; path: string }
  "git/unstage": { cwd: string; path: string }
}

export type WorkspaceRpcResponses = {
  "workspace/list": WorkspaceListResponse
  "workspace/read": WorkspaceReadResponse
  "workspace/readMedia": WorkspaceReadMediaResponse
  "workspace/readOffice": WorkspaceReadOfficeResponse
  "workspace/readForEdit": WorkspaceReadForEditResponse
  "workspace/write": WorkspaceWriteResponse
  "workspace/findFiles": WorkspaceFindFilesResponse
  "git/status": GitStatusResponse
  "git/pullRequests": GitPullRequestsResponse
  "git/diff": GitDiffResponse
  "git/stage": Record<string, never>
  "git/unstage": Record<string, never>
}
