import type {
  ToolApprovalRequirement,
  ToolPermissionRequest,
} from "./tools/types.ts"

export function resolveToolPermissionRequest(
  requirement: ToolApprovalRequirement,
  policy: string,
): ToolPermissionRequest | undefined {
  if (policy !== "never" && policy !== "auto_file_tools") {
    throw new Error(`Unsupported approval policy: ${policy}`)
  }
  if (requirement.kind === "none" || policy === "never") return undefined
  if (requirement.action === "file_change" && policy === "auto_file_tools") {
    return undefined
  }
  return {
    kind: "tool",
    action: requirement.action,
    ...(requirement.subject === undefined
      ? {}
      : { subject: requirement.subject }),
    ...(requirement.reason === undefined ? {} : { reason: requirement.reason }),
  }
}
