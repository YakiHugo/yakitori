import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { open, opendir, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { ToolLimitDefaults } from "../runtime/limits.ts"
import {
  captureTextFilePage,
  FileChangedDuringReadError,
  UnsupportedTextFileTypeError,
} from "../runtime/tools/read-file-page.ts"
import { runRipgrepRecords } from "../runtime/tools/ripgrep.ts"
import { compareAndWriteTextFile } from "../runtime/tools/text-file-write.ts"

// These are implementation safety bounds for rendering and subprocess memory.
const MAX_DIRECTORY_ENTRIES = 1_000
const MAX_FILE_LINES = 1_000
const MAX_FILE_BYTES = 256 * 1024
const MAX_GIT_BYTES = 1024 * 1024
// Complete editor documents share the tool writer's memory safety boundary.
const MAX_EDIT_FILE_BYTES = ToolLimitDefaults.fileWriteBytes
// Bound filename results, scanning memory, and subprocess time for the GUI.
const MAX_FIND_FILES = 200
// One-shot index fetch for the @-mention picker's client-side filtering.
const MAX_FIND_FILES_INDEX = 20_000
const MAX_FIND_FILE_BYTES = 8 * 1024 * 1024
const executeFile = promisify(execFile)

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

export class WorkspaceError extends Error {
  readonly code: "invalid_input" | "not_found" | "conflict"

  constructor(
    message: string,
    code: "invalid_input" | "not_found" | "conflict" = "invalid_input",
  ) {
    super(message)
    this.name = "WorkspaceError"
    this.code = code
  }
}

export async function listWorkspaceDirectory(input: {
  cwd: string
  path?: string
}): Promise<WorkspaceListResponse> {
  const cwd = await workspaceRoot(input.cwd)
  const target = await workspacePath(cwd, input.path ?? ".")
  const directory = await opendir(target)
  const entries: WorkspaceListResponse["entries"] = []
  let truncated = false
  for await (const entry of directory) {
    if (entry.name === ".git") continue
    if (entries.length === MAX_DIRECTORY_ENTRIES) {
      truncated = true
      break
    }
    entries.push({
      name: entry.name,
      path: displayPath(cwd, resolve(target, entry.name)),
      kind: entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : entry.isFile()
            ? "file"
            : "other",
    })
  }
  entries.sort(
    (left, right) =>
      Number(right.kind === "directory") - Number(left.kind === "directory") ||
      left.name.localeCompare(right.name),
  )
  return { cwd, path: displayPath(cwd, target), entries, truncated }
}

export async function readWorkspaceFile(input: {
  cwd: string
  path: string
  offset?: number
  limit?: number
}): Promise<WorkspaceReadResponse> {
  const cwd = await workspaceRoot(input.cwd)
  const target = await workspacePath(cwd, input.path)
  const offset = input.offset ?? 1
  const limit = input.limit ?? 500
  if (!Number.isSafeInteger(offset) || offset < 1)
    throw new WorkspaceError("offset must be a positive integer.")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILE_LINES)
    throw new WorkspaceError(`limit must be between 1 and ${MAX_FILE_LINES}.`)
  const path = displayPath(cwd, target)
  let page: Awaited<ReturnType<typeof captureTextFilePage>>
  try {
    page = await captureTextFilePage({
      absolutePath: target,
      offset,
      limit,
      maxLineCharacters: 2_000,
    })
  } catch (error) {
    if (error instanceof FileChangedDuringReadError)
      throw new WorkspaceError(
        "File changed while reading. Refresh to retry.",
        "conflict",
      )
    if (error instanceof UnsupportedTextFileTypeError)
      throw new WorkspaceError("Only regular text files can be previewed.")
    if (
      error instanceof TypeError &&
      "code" in error &&
      error.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
    )
      return { path, content: "", offset, truncated: false, binary: true }
    throw error
  }
  if (page.binary)
    return { path, content: "", offset, truncated: false, binary: true }
  const lines: string[] = []
  let bytes = 0
  let shortened = false
  for (const line of page.lines.values()) {
    const text =
      line.full ?? `${line.head ?? ""}…[line truncated]…${line.tail ?? ""}`
    const size = Buffer.byteLength(text, "utf8") + 1
    if (bytes + size > MAX_FILE_BYTES) break
    bytes += size
    lines.push(text)
    shortened ||= line.full === undefined
  }
  const hasMore = page.hasMore || lines.length < page.lines.size
  return {
    path,
    content: lines.join("\n"),
    offset,
    ...(hasMore ? { nextOffset: offset + lines.length } : {}),
    truncated: hasMore || shortened,
    binary: false,
  }
}

export async function readWorkspaceFileForEdit(input: {
  cwd: string
  path: string
}): Promise<WorkspaceReadForEditResponse> {
  const cwd = await workspaceRoot(input.cwd)
  const target = await workspacePath(cwd, input.path)
  const flags =
    constants.O_RDONLY |
    (process.platform === "win32"
      ? 0
      : constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  const handle = await open(target, flags)
  try {
    const before = await handle.stat()
    if (!before.isFile())
      throw new WorkspaceError("Only regular UTF-8 text files can be edited.")
    if (before.size > MAX_EDIT_FILE_BYTES)
      throw new WorkspaceError(
        `File exceeds the ${MAX_EDIT_FILE_BYTES}-byte editor safety limit.`,
      )
    // One extra byte detects growth without allocating an unbounded document.
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      )
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    const currentTarget = await workspacePath(cwd, input.path)
    const current = await stat(currentTarget)
    if (
      (await workspaceRoot(input.cwd)) !== cwd ||
      currentTarget !== target ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== current.size ||
      before.mtimeMs !== current.mtimeMs ||
      before.ctimeMs !== current.ctimeMs ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      length !== before.size
    ) {
      throw new WorkspaceError(
        "File changed while reading. Reload before editing.",
        "conflict",
      )
    }
    const bytes = buffer.subarray(0, length)
    if (bytes.includes(0))
      throw new WorkspaceError("Binary files cannot be edited as UTF-8 text.")
    let content: string
    try {
      // ignoreBOM retains a UTF-8 BOM as text so saving preserves its bytes.
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes)
    } catch (error) {
      if (
        error instanceof TypeError &&
        "code" in error &&
        error.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
      )
        throw new WorkspaceError("File is not valid UTF-8 text.")
      throw error
    }
    return {
      path: displayPath(cwd, target),
      content,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  } finally {
    await handle.close()
  }
}

export async function writeWorkspaceFile(input: {
  cwd: string
  path: string
  content: string
  expectedSha256: string
}): Promise<WorkspaceWriteResponse> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256))
    throw new WorkspaceError("expectedSha256 must be a SHA-256 file revision.")
  if (Buffer.byteLength(input.content, "utf8") > MAX_EDIT_FILE_BYTES)
    throw new WorkspaceError(
      `Content exceeds the ${MAX_EDIT_FILE_BYTES}-byte editor safety limit.`,
    )
  const contentBytes = Buffer.from(input.content, "utf8")
  // Buffer replaces unpaired UTF-16 surrogates; reject rather than save bytes
  // that differ from the submitted editor document.
  if (
    contentBytes.toString("utf8") !== input.content ||
    contentBytes.includes(0)
  )
    throw new WorkspaceError("content must be valid UTF-8 text without NUL.")
  const cwd = await workspaceRoot(input.cwd)
  let target: string
  try {
    target = await workspacePath(cwd, input.path)
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      throw new WorkspaceError("The file no longer exists.", "conflict")
    throw error
  }
  let original: Stats | undefined
  const written = await compareAndWriteTextFile({
    workspaceRoot: cwd,
    path: target,
    content: input.content,
    expectedSha256: input.expectedSha256,
    async validateTarget(absolutePath) {
      if (
        (await workspaceRoot(input.cwd)) !== cwd ||
        absolutePath !== target ||
        (await workspacePath(cwd, input.path)) !== target ||
        (await workspacePath(cwd, displayPath(cwd, target))) !== target
      )
        throw new WorkspaceError(
          "File path changed. Reload before saving.",
          "conflict",
        )
      const info = await stat(absolutePath)
      if (!info.isFile())
        throw new WorkspaceError("Only regular UTF-8 text files can be edited.")
      if (info.size > MAX_EDIT_FILE_BYTES)
        throw new WorkspaceError(
          "File grew beyond the editor safety limit. Reload before saving.",
          "conflict",
        )
      if (
        original !== undefined &&
        (info.dev !== original.dev ||
          info.ino !== original.ino ||
          info.size !== original.size ||
          info.mtimeMs !== original.mtimeMs ||
          info.ctimeMs !== original.ctimeMs)
      )
        throw new WorkspaceError("File changed while saving.", "conflict")
      original = info
    },
  })
  if (!written.ok)
    throw new WorkspaceError(
      `${written.message} Reload before saving; your changes have not been written.`,
      "conflict",
    )
  return {
    path: displayPath(cwd, target),
    sha256: createHash("sha256").update(contentBytes).digest("hex"),
  }
}

export async function findWorkspaceFiles(input: {
  cwd: string
  query: string
  limit?: number
}): Promise<WorkspaceFindFilesResponse> {
  const cwd = await workspaceRoot(input.cwd)
  const query = input.query.toLowerCase()
  // An empty query lists the workspace index itself; the @-mention picker
  // caches it and filters client-side instead of rescanning per keystroke.
  const limit = Math.min(input.limit ?? MAX_FIND_FILES, MAX_FIND_FILES_INDEX)
  const paths: string[] = []
  const result = await runRipgrepRecords(
    [
      "--files",
      "--hidden",
      "--null",
      "--no-config",
      "--glob",
      "!.git",
      "--",
      ".",
    ],
    {
      cwd,
      timeoutMs: 5_000,
      maxBytes: MAX_FIND_FILE_BYTES,
      maxRecordBytes: 64 * 1024,
      delimiter: "null",
      onRecord(record) {
        const path = record.replace(/^\.\//, "")
        if (!path.toLowerCase().includes(query)) return true
        if (paths.length >= limit) return false
        paths.push(path)
        return true
      },
    },
  )
  if (!result.ok) throw new WorkspaceError(result.message, "conflict")
  return {
    paths: paths.sort((left, right) => left.localeCompare(right)),
    truncated: result.stopReason !== undefined,
  }
}

export async function readWorkspaceGitStatus(input: {
  cwd: string
}): Promise<GitStatusResponse> {
  const cwd = await workspaceRoot(input.cwd)
  const rootResult = await git(cwd, ["rev-parse", "--show-toplevel"], [128])
  if (rootResult.code !== 0) {
    if (rootResult.stderr.includes("not a git repository"))
      return { repository: false, entries: [] }
    throw new WorkspaceError(rootResult.stderr.trim(), "conflict")
  }
  const root = await realpath(rootResult.text.replace(/\n$/, ""))
  const branchResult = await git(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    [1],
  )
  const status = await git(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
  ])
  const records = status.text.split("\0")
  const entries: WorkspaceGitEntry[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const indexStatus = record[0] ?? " "
    const worktreeStatus = record[1] ?? " "
    const path = displayPath(cwd, resolve(root, record.slice(3)))
    const renamed =
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C"
    const originalPath = renamed ? records[++index] : undefined
    entries.push({
      path,
      ...(originalPath === undefined
        ? {}
        : { originalPath: displayPath(cwd, resolve(root, originalPath)) }),
      indexStatus,
      worktreeStatus,
    })
  }
  return {
    repository: true,
    root,
    branch:
      branchResult.code === 0 ? branchResult.text.trimEnd() : "Detached HEAD",
    entries,
  }
}

export async function readWorkspaceGitInfo(input: {
  cwd: string
}): Promise<WorkspaceGitInfo | undefined> {
  const cwd = await workspaceRoot(input.cwd)
  const repository = await git(cwd, ["rev-parse", "--show-toplevel"], [128])
  if (repository.code !== 0) return
  const [sha, branch, origin] = await Promise.all([
    git(cwd, ["rev-parse", "--verify", "HEAD"], [128]),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], [1]),
    git(cwd, ["remote", "get-url", "origin"], [2]),
  ])
  const info = {
    ...(sha.code === 0 ? { sha: sha.text.trimEnd() } : {}),
    ...(branch.code === 0 ? { branch: branch.text.trimEnd() } : {}),
    ...(origin.code === 0 ? { originUrl: origin.text.trimEnd() } : {}),
  }
  return Object.keys(info).length === 0 ? undefined : info
}

export async function readWorkspacePullRequests(input: {
  cwd: string
  branch: string
}): Promise<GitPullRequestsResponse> {
  const cwd = await workspaceRoot(input.cwd)
  if (input.branch.length === 0 || input.branch.includes("\0")) {
    throw new WorkspaceError("branch is required.")
  }
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  )
  try {
    const result = await executeFile(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        input.branch,
        "--limit",
        "50",
        "--json",
        "number,title,state,isDraft,url,headRefName,updatedAt",
      ],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_GIT_BYTES,
        timeout: 10_000,
        env: {
          ...environment,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    )
    return {
      available: true,
      pullRequests: parsePullRequests(result.stdout),
    }
  } catch {
    return { available: false, reason: "unavailable" }
  }
}

function parsePullRequests(value: string): readonly WorkspacePullRequest[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new WorkspaceError("GitHub CLI returned invalid PR data.", "conflict")
  }
  if (!Array.isArray(parsed)) {
    throw new WorkspaceError("GitHub CLI returned invalid PR data.", "conflict")
  }
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("number" in entry) ||
      typeof entry.number !== "number" ||
      !Number.isSafeInteger(entry.number) ||
      !("title" in entry) ||
      typeof entry.title !== "string" ||
      !("state" in entry) ||
      (entry.state !== "OPEN" &&
        entry.state !== "CLOSED" &&
        entry.state !== "MERGED") ||
      !("isDraft" in entry) ||
      typeof entry.isDraft !== "boolean" ||
      !("url" in entry) ||
      typeof entry.url !== "string" ||
      !("headRefName" in entry) ||
      typeof entry.headRefName !== "string" ||
      !("updatedAt" in entry) ||
      typeof entry.updatedAt !== "string"
    ) {
      throw new WorkspaceError(
        "GitHub CLI returned invalid PR data.",
        "conflict",
      )
    }
    return {
      number: entry.number,
      title: entry.title,
      state: entry.state,
      isDraft: entry.isDraft,
      url: entry.url,
      headRefName: entry.headRefName,
      updatedAt: entry.updatedAt,
    }
  })
}

export async function readWorkspaceGitDiff(input: {
  cwd: string
  path: string
  staged: boolean
}): Promise<GitDiffResponse> {
  const cwd = await workspaceRoot(input.cwd)
  const target = await workspacePath(cwd, input.path, true)
  const path = displayPath(cwd, target)
  const status = await readWorkspaceGitStatus({ cwd })
  if (!status.repository)
    throw new WorkspaceError("This folder is not a Git repository.")
  const entry = status.entries.find((candidate) => candidate.path === path)
  const paths = await changePaths(cwd, path, entry)
  const untracked = !input.staged && entry?.indexStatus === "?"
  const result = untracked
    ? await git(
        cwd,
        [
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          "/dev/null",
          target,
        ],
        [1],
        true,
      )
    : await git(
        cwd,
        [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.staged ? ["--cached"] : []),
          "--",
          ...paths,
        ],
        [],
        true,
      )
  return { path, text: result.text, truncated: result.truncated }
}

export async function changeWorkspaceGitIndex(input: {
  cwd: string
  path: string
  staged: boolean
}): Promise<void> {
  const cwd = await workspaceRoot(input.cwd)
  const path = displayPath(cwd, await workspacePath(cwd, input.path, true))
  const status = await readWorkspaceGitStatus({ cwd })
  if (!status.repository)
    throw new WorkspaceError("This folder is not a Git repository.")
  const entry = status.entries.find((candidate) => candidate.path === path)
  if (entry === undefined)
    throw new WorkspaceError("The file has no pending Git changes.", "conflict")
  const paths = await changePaths(cwd, path, entry)
  if (input.staged) {
    await git(cwd, ["add", "-A", "--", ...paths])
    return
  }
  const head = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], [1])
  await git(
    cwd,
    head.code === 0
      ? ["reset", "--quiet", "HEAD", "--", ...paths]
      : ["rm", "--cached", "--force", "--ignore-unmatch", "--", ...paths],
  )
}

async function changePaths(
  cwd: string,
  path: string,
  entry?: WorkspaceGitEntry,
): Promise<string[]> {
  if (entry?.originalPath === undefined) return [path]
  await workspacePath(cwd, entry.originalPath, true)
  return [path, entry.originalPath]
}

async function workspaceRoot(cwd: string): Promise<string> {
  if (!isAbsolute(cwd) || cwd.includes("\0"))
    throw new WorkspaceError("cwd must be an absolute directory path.")
  const root = await realpath(cwd)
  if (!(await stat(root)).isDirectory())
    throw new WorkspaceError("cwd must be a directory.")
  return root
}

async function workspacePath(
  cwd: string,
  path: string,
  indexPath = false,
): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\0"))
    throw new WorkspaceError("path must be relative to the workspace.")
  const candidate = resolve(cwd, path)
  requireInside(cwd, candidate)
  if (relative(cwd, candidate).split(sep).includes(".git"))
    throw new WorkspaceError(
      "Git internal files are not part of the workspace browser.",
    )
  if (!indexPath) {
    const canonical = await realpath(candidate)
    requireInside(cwd, canonical)
    if (relative(cwd, canonical).split(sep).includes(".git"))
      throw new WorkspaceError(
        "Git internal files are not part of the workspace browser.",
      )
    return canonical
  }
  // Git operates on the symlink itself and on deleted files. Validate the
  // nearest existing parent without following the final symlink.
  let parent = dirname(candidate)
  for (;;) {
    try {
      requireInside(cwd, await realpath(parent))
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      parent = dirname(parent)
    }
  }
}

function requireInside(cwd: string, target: string): void {
  const path = relative(cwd, target)
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
    throw new WorkspaceError("Path must stay within the workspace.")
}

function displayPath(cwd: string, target: string): string {
  return relative(cwd, target).split(sep).join("/") || "."
}

async function git(
  cwd: string,
  args: string[],
  acceptedExitCodes: number[] = [],
  allowTruncated = false,
): Promise<{ text: string; stderr: string; code: number; truncated: boolean }> {
  // A server launched from a Git hook must not inherit another repository's
  // index or worktree. This surface always operates on the explicit cwd.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  )
  try {
    const result = await executeFile(
      "git",
      ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_GIT_BYTES,
        timeout: 10_000,
        env: {
          ...environment,
          LC_ALL: "C",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    )
    return {
      text: result.stdout,
      stderr: result.stderr,
      code: 0,
      truncated: false,
    }
  } catch (error) {
    const failure = error as {
      code?: string | number
      stdout?: string
      stderr?: string
      killed?: boolean
    }
    if (
      typeof failure.code === "number" &&
      acceptedExitCodes.includes(failure.code)
    )
      return {
        text: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        code: failure.code,
        truncated: false,
      }
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && allowTruncated)
      return {
        text: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        code: 0,
        truncated: true,
      }
    if (failure.code === "ENOENT")
      throw new WorkspaceError(
        "Git is not installed or available on PATH.",
        "not_found",
      )
    if (
      typeof failure.code === "number" ||
      failure.killed === true ||
      failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      throw new WorkspaceError(
        failure.stderr?.trim() ||
          "Git command failed or exceeded its output/time safety bound.",
        "conflict",
      )
    throw error
  }
}
