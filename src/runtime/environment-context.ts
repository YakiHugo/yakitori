import { existsSync } from "node:fs"
import { release } from "node:os"
import { join } from "node:path"

export type EnvironmentContextInput = {
  readonly workingDirectory: string
  readonly now?: Date
}

/**
 * Small, bounded environment block appended to the system prompt of every
 * model call. Not recorded in durable facts; turn.started already records
 * the working directory, provider, and model.
 */
export function buildEnvironmentContext(
  input: EnvironmentContextInput,
): string {
  const gitRepo = existsSync(join(input.workingDirectory, ".git"))
  return [
    "<environment>",
    `Working directory: ${input.workingDirectory}`,
    `Is directory a git repo: ${gitRepo ? "yes" : "no"}`,
    `Platform: ${process.platform}`,
    `OS version: ${release()}`,
    `Today's date: ${formatLocalDate(input.now ?? new Date())}`,
    "</environment>",
  ].join("\n")
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
