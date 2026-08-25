import type { ToolApprovalRequirement } from "./types.ts"

export const noToolApprovalRequired: ToolApprovalRequirement = {
  kind: "none",
}

export function fileChangeApprovalRequirement(
  input: unknown,
): ToolApprovalRequirement {
  return {
    kind: "approval",
    action: "file_change",
    ...subjectFrom(input, "path"),
    reason: "This tool changes files using the host user's authority.",
  }
}

export function commandApprovalRequirement(input: {
  readonly command: string
  readonly cwd: string
}): ToolApprovalRequirement {
  return {
    kind: "approval",
    action: "command_execution",
    subject: input.command,
    reason: `Runs in ${input.cwd} with the host user's filesystem, process, environment, and network authority.`,
  }
}

function subjectFrom(
  input: unknown,
  field: string,
): { readonly subject?: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {}
  }
  const subject = (input as Record<string, unknown>)[field]
  return typeof subject === "string" ? { subject } : {}
}
