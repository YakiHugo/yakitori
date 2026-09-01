const SEGMENT = /^[A-Za-z0-9_-]+$/

export type ToolName = Readonly<{
  namespace?: string
  name: string
}>

export function plainToolName(name: string): ToolName {
  validateSegment(name, "tool")
  return { name }
}

export function namespacedToolName(namespace: string, name: string): ToolName {
  validateSegment(namespace, "tool namespace")
  validateSegment(name, "tool")
  validateNamespacedBoundary(namespace, name)
  return { namespace, name }
}

export function canonicalToolName(toolName: ToolName): string {
  validateSegment(toolName.name, "tool")
  if (toolName.namespace !== undefined) {
    validateSegment(toolName.namespace, "tool namespace")
    validateNamespacedBoundary(toolName.namespace, toolName.name)
  }
  return toolName.namespace === undefined
    ? toolName.name
    : `${toolName.namespace}__${toolName.name}`
}

function validateNamespacedBoundary(namespace: string, name: string): void {
  if (namespace.endsWith("_") || name.startsWith("_")) {
    throw new Error(
      `Invalid namespaced tool boundary: ${JSON.stringify(namespace)} and ${JSON.stringify(name)}. Namespaces must not end with an underscore and names must not begin with one.`,
    )
  }
}

function validateSegment(value: string, label: string): void {
  if (!SEGMENT.test(value) || value.includes("__")) {
    throw new Error(
      `Invalid ${label} name: ${JSON.stringify(value)}. Use letters, numbers, underscores, or hyphens without a double-underscore separator.`,
    )
  }
}
