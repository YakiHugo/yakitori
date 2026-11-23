const hostedToolKinds = [
  "web_search",
  "web_fetch",
  "file_search",
  "code_execution",
  "mcp",
  "image_generation",
  "lookup",
] as const

const hostedToolStatuses = [
  "running",
  "completed",
  "failed",
  "interrupted",
] as const

export type HostedToolBlock = Readonly<{
  type: "hosted_tool"
  id: string
  kind: (typeof hostedToolKinds)[number]
  status: (typeof hostedToolStatuses)[number]
  label?: string
  detail?: string
  sourceCode?: string
}>

export function isHostedToolBlock(value: unknown): value is HostedToolBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  if (
    !("type" in value) ||
    value.type !== "hosted_tool" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  )
    return false
  return (
    "kind" in value &&
    hostedToolKinds.some((kind) => kind === value.kind) &&
    "status" in value &&
    hostedToolStatuses.some((status) => status === value.status) &&
    (!("label" in value) || typeof value.label === "string") &&
    (!("detail" in value) || typeof value.detail === "string") &&
    (!("sourceCode" in value) ||
      (value.kind === "code_execution" &&
        typeof value.sourceCode === "string")) &&
    Object.keys(value).every((key) =>
      [
        "type",
        "id",
        "kind",
        "status",
        "label",
        "detail",
        "sourceCode",
      ].includes(key),
    )
  )
}
