import { existsSync } from "node:fs"
import { release } from "node:os"
import { join } from "node:path"

export type EnvironmentSnapshot = {
  readonly workspaceRoot: string
  readonly workingDirectory: string
  readonly isGitRepository: boolean
  readonly platform: string
  readonly osVersion: string
  readonly currentDate: string
  readonly timezone: string
}

export type EnvironmentContextInput = {
  readonly workspaceRoot?: string
  readonly workingDirectory: string
  readonly now?: Date
}

export function observeEnvironment(
  input: EnvironmentContextInput,
): EnvironmentSnapshot {
  const workspaceRoot = input.workspaceRoot ?? input.workingDirectory
  const now = input.now ?? new Date()
  return {
    workspaceRoot,
    workingDirectory: input.workingDirectory,
    isGitRepository: existsSync(join(workspaceRoot, ".git")),
    platform: process.platform,
    osVersion: release(),
    currentDate: formatLocalDate(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

export function renderEnvironmentContext(
  snapshot: EnvironmentSnapshot,
): string {
  return [
    "<environment>",
    `Workspace root: ${snapshot.workspaceRoot}`,
    `Working directory: ${snapshot.workingDirectory}`,
    `Is workspace a git repo: ${snapshot.isGitRepository ? "yes" : "no"}`,
    `Platform: ${snapshot.platform}`,
    `OS version: ${snapshot.osVersion}`,
    `Today's date: ${snapshot.currentDate}`,
    `Timezone: ${snapshot.timezone}`,
    "</environment>",
  ].join("\n")
}

export function buildEnvironmentContext(
  input: EnvironmentContextInput,
): string {
  return renderEnvironmentContext(observeEnvironment(input))
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
