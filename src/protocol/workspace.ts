export type WorkspaceListResponse = {
  cwd: string
  path: string
  entries: {
    name: string
    path: string
    kind: "file" | "directory" | "symlink" | "other"
  }[]
  truncated: boolean
}

export type WorkspaceReadResponse = {
  path: string
  content: string
  offset: number
  nextOffset?: number
  truncated: boolean
  binary: boolean
}

export type WorkspaceReadMediaResponse = Readonly<{
  path: string
  mimeType: string
  base64: string
}>

export type WorkspaceReadForEditResponse = Readonly<{
  path: string
  content: string
  sha256: string
}>

export type WorkspaceWriteResponse = Readonly<{
  path: string
  sha256: string
}>

export type WorkspaceFindFilesResponse = Readonly<{
  paths: string[]
  truncated: boolean
}>

export type WorkspaceGitEntry = {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
}

export type GitStatusResponse = {
  repository: boolean
  root?: string
  branch?: string
  entries: WorkspaceGitEntry[]
}

export type WorkspaceGitInfo = Readonly<{
  sha?: string
  branch?: string
  originUrl?: string
}>

export type WorkspacePullRequest = Readonly<{
  number: number
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  url: string
  headRefName: string
  updatedAt: string
}>

export type GitPullRequestsResponse =
  | Readonly<{
      available: true
      pullRequests: readonly WorkspacePullRequest[]
    }>
  | Readonly<{
      available: false
      reason: "not_configured" | "unavailable"
    }>

export type GitDiffResponse = {
  path: string
  text: string
  truncated: boolean
}

export type WorkspaceReadOfficeResponse =
  | {
      path: string
      kind: "docx"
      blocks: (
        | { kind: "paragraph"; text: string }
        | { kind: "table"; rows: string[][] }
      )[]
      truncated: boolean
    }
  | {
      path: string
      kind: "xlsx"
      sheets: { name: string; rows: string[][] }[]
      truncated: boolean
    }
  | {
      path: string
      kind: "pptx"
      slides: { number: number; paragraphs: string[]; notes: string[] }[]
      truncated: boolean
    }
