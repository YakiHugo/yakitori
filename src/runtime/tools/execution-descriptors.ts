import type {
  CollaborationAction,
  CollaborationReceiver,
  JsonValue,
  ToolExecutionDescriptor,
} from "../../kernel/index.ts"

export function commandExecution(input: JsonValue): ToolExecutionDescriptor {
  const fields = recordOf(input)
  const description = stringOf(fields?.description)
  return {
    type: "command_execution",
    command: stringOf(fields?.command) ?? "",
    ...(description === undefined ? {} : { description }),
  }
}

export function fileChangeExecution(
  operation: "edit" | "write" | "apply_patch",
): (
  input: JsonValue,
) => Extract<ToolExecutionDescriptor, { readonly type: "file_change" }> {
  return (input) => {
    const path = stringOf(recordOf(input)?.path)
    return {
      type: "file_change",
      request: {
        operation,
        paths: path === undefined ? [] : [path],
      },
      changes: [],
    }
  }
}

export function completeFileChangeExecution(
  started: ToolExecutionDescriptor,
  output: JsonValue,
  succeeded = true,
): ToolExecutionDescriptor {
  if (started.type !== "file_change" || !succeeded) return started
  const fields = recordOf(output)
  const path = stringOf(fields?.path) ?? started.request.paths[0]
  if (path === undefined) return started
  const diff = unifiedDiffOf(fields?.diff)
  return {
    ...started,
    changes: [
      {
        path,
        kind: fields?.created === true ? "add" : "update",
        ...(diff === undefined ? {} : { diff }),
      },
    ],
  }
}

export function completeCommandExecution(
  started: ToolExecutionDescriptor,
  output: JsonValue,
): ToolExecutionDescriptor {
  if (started.type !== "command_execution") return started
  const fields = recordOf(output)
  if (fields === undefined) return started
  const result = commandResultOf(fields)
  return result === undefined ? started : { ...started, result }
}

export function completeFileReadExecution(
  started: ToolExecutionDescriptor,
  output: JsonValue,
  succeeded = true,
): ToolExecutionDescriptor {
  if (started.type !== "file_read" || !succeeded) return started
  const fields = recordOf(output)
  return fields === undefined
    ? started
    : { ...started, result: fileReadResultOf(fields, started.path) }
}

export function completeFileSearchExecution(
  started: ToolExecutionDescriptor,
  output: JsonValue,
  succeeded = true,
): ToolExecutionDescriptor {
  if (started.type !== "file_search" || !succeeded) return started
  const fields = recordOf(output)
  if (fields === undefined) return started
  const result = fileSearchResultOf(fields, started)
  return result === undefined ? started : { ...started, result }
}

export function completeWebFetchExecution(
  started: ToolExecutionDescriptor,
  output: JsonValue,
  succeeded = true,
): ToolExecutionDescriptor {
  if (started.type !== "web_fetch" || !succeeded) return started
  const fields = recordOf(output)
  if (fields === undefined) return started
  const result = webFetchResultOf(fields)
  return result === undefined ? started : { ...started, result }
}

export function completeWebSearchExecution(
  started: ToolExecutionDescriptor,
  output: JsonValue,
  succeeded = true,
): ToolExecutionDescriptor {
  if (started.type !== "web_search" || !succeeded) return started
  const fields = recordOf(output)
  return fields === undefined
    ? started
    : { ...started, result: { links: webLinksOf(fields.links) } }
}

export function fileReadExecution(input: JsonValue): ToolExecutionDescriptor {
  const fields = recordOf(input)
  const offset = numberOf(fields?.offset)
  const limit = numberOf(fields?.limit)
  return {
    type: "file_read",
    path: stringOf(fields?.path) ?? "",
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function fileSearchExecution(
  operation: "grep" | "glob",
): (input: JsonValue) => ToolExecutionDescriptor {
  return (input) => {
    const fields = recordOf(input)
    const path = stringOf(fields?.path)
    const outputMode = searchOutputMode(stringOf(fields?.output_mode))
    return {
      type: "file_search",
      operation,
      pattern: stringOf(fields?.pattern) ?? "",
      ...(path === undefined ? {} : { path }),
      ...(outputMode === undefined ? {} : { outputMode }),
      lineNumbers: fields?.["-n"] !== false,
    }
  }
}

export function webFetchExecution(input: JsonValue): ToolExecutionDescriptor {
  return {
    type: "web_fetch",
    url: stringOf(recordOf(input)?.url) ?? "",
  }
}

export function webSearchExecution(input: JsonValue): ToolExecutionDescriptor {
  return {
    type: "web_search",
    query: stringOf(recordOf(input)?.query) ?? "",
  }
}

export function collaborationExecution(
  action: CollaborationAction,
  receivers: ReadonlyArray<CollaborationReceiver> = [],
): (input: JsonValue) => ToolExecutionDescriptor {
  return (input) => {
    const fields = recordOf(input)
    return {
      type: "collaboration_tool_call",
      action,
      description:
        stringOf(fields?.message) ??
        stringOf(fields?.task_name) ??
        stringOf(fields?.target) ??
        stringOf(fields?.path_prefix) ??
        action,
      receivers,
    }
  }
}

export function completeCollaborationExecution(
  started: ToolExecutionDescriptor,
  output: JsonValue,
  succeeded = true,
): ToolExecutionDescriptor {
  return started.type === "collaboration_tool_call" && succeeded
    ? { ...started, receivers: collaborationReceiversOf(output) }
    : started
}

export function dynamicToolExecution(): ToolExecutionDescriptor {
  return { type: "dynamic_tool_call" }
}

export function mcpToolExecution(
  input: Readonly<{
    server: string
    tool: string
    arguments: JsonValue
    readOnlyHint?: boolean
  }>,
): ToolExecutionDescriptor {
  return {
    type: "mcp_tool_call",
    server: input.server,
    tool: input.tool,
    arguments: input.arguments,
    ...(input.readOnlyHint === undefined
      ? {}
      : { readOnlyHint: input.readOnlyHint }),
  }
}

function recordOf(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined
}

function stringOf(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberOf(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function searchOutputMode(
  value: string | undefined,
): "content" | "files_with_matches" | "count" | undefined {
  if (value === "count_matches") return "count"
  return value === "content" ||
    value === "files_with_matches" ||
    value === "count"
    ? value
    : undefined
}

function unifiedDiffOf(value: JsonValue | undefined):
  | {
      readonly format: "unified"
      readonly text: string
      readonly truncated: boolean
    }
  | undefined {
  const fields = recordOf(value)
  if (
    fields?.format !== "unified" ||
    typeof fields.text !== "string" ||
    typeof fields.truncated !== "boolean"
  ) {
    return undefined
  }
  return {
    format: "unified",
    text: fields.text,
    truncated: fields.truncated,
  }
}

function commandResultOf(fields: Record<string, JsonValue>) {
  if (
    typeof fields.stdout !== "string" ||
    typeof fields.stderr !== "string" ||
    typeof fields.truncated !== "boolean"
  ) {
    return undefined
  }
  const warnings = stringArrayOf(fields.warnings)
  const blockedFields = recordOf(fields.blocked)
  const binaryFields = recordOf(fields.binary)
  const blocked = stringOf(blockedFields?.rule)
  const binary =
    typeof binaryFields?.stdout === "boolean" &&
    typeof binaryFields.stderr === "boolean" &&
    typeof binaryFields.stdoutBytes === "number" &&
    typeof binaryFields.stderrBytes === "number"
      ? {
          stdout: binaryFields.stdout,
          stderr: binaryFields.stderr,
          stdoutBytes: binaryFields.stdoutBytes,
          stderrBytes: binaryFields.stderrBytes,
        }
      : undefined
  return {
    exitCode:
      typeof fields.exitCode === "number" || fields.exitCode === null
        ? fields.exitCode
        : null,
    signal: typeof fields.signal === "string" ? fields.signal : null,
    stdout: fields.stdout,
    stderr: fields.stderr,
    truncated: fields.truncated,
    timedOut: fields.timedOut === true,
    ...(typeof fields.durationMs === "number"
      ? { durationMs: fields.durationMs }
      : {}),
    ...(typeof fields.cwd === "string" ? { cwd: fields.cwd } : {}),
    ...(typeof fields.shell === "string" ? { shell: fields.shell } : {}),
    ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
    ...(blocked === undefined ? {} : { blocked: { rule: blocked } }),
    ...(binary === undefined ? {} : { binary }),
  }
}

function fileReadResultOf(
  fields: Record<string, JsonValue>,
  requestedPath: string,
) {
  const path = stringOf(fields.path) ?? requestedPath
  const range = recordOf(fields.range)
  const offset = numberOf(range?.offset)
  const limit = numberOf(range?.limit)
  const entries = stringArrayOf(fields.entries)
  return {
    path,
    kind:
      fields.kind === "directory" ? ("directory" as const) : ("file" as const),
    ...(typeof fields.count === "number" ? { count: fields.count } : {}),
    ...(entries === undefined ? {} : { entries }),
    ...(offset === undefined || limit === undefined
      ? {}
      : { range: { offset, limit } }),
    empty: fields.empty === true || fields.count === 0,
    truncated: fields.truncated === true,
  }
}

function fileSearchResultOf(
  fields: Record<string, JsonValue>,
  started: Extract<ToolExecutionDescriptor, { readonly type: "file_search" }>,
) {
  const path = stringOf(fields.path) ?? started.path ?? "."
  const outputMode = searchOutputMode(
    stringOf(fields.outputMode) ??
      started.outputMode ??
      (started.operation === "glob" ? "files_with_matches" : undefined),
  )
  if (outputMode === undefined || typeof fields.count !== "number") {
    return undefined
  }
  const paths = stringArrayOf(fields.paths)
  const matches = searchMatchesOf(fields.locations)
  return {
    path,
    outputMode,
    count: fields.count,
    truncated: fields.truncated === true,
    timedOut: fields.timedOut === true,
    ...(paths === undefined ? {} : { paths }),
    ...(matches.length === 0 ? {} : { matches }),
  }
}

function webFetchResultOf(fields: Record<string, JsonValue>) {
  if (typeof fields.url !== "string" || typeof fields.status !== "number") {
    return undefined
  }
  return {
    url: fields.url,
    status: fields.status,
    truncated: fields.truncated === true,
  }
}

function webLinksOf(value: JsonValue | undefined) {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const fields = recordOf(entry)
    const title = stringOf(fields?.title)
    const url = stringOf(fields?.url)
    return title === undefined || url === undefined ? [] : [{ title, url }]
  })
}

function searchMatchesOf(value: JsonValue | undefined) {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const fields = recordOf(entry)
    const path = stringOf(fields?.path)
    if (path === undefined) return []
    const line = numberOf(fields?.line)
    const text = stringValueOf(fields?.text)
    const count = numberOf(fields?.count)
    return [
      {
        path,
        ...(line === undefined ? {} : { line }),
        ...(text === undefined ? {} : { text }),
        ...(count === undefined ? {} : { count }),
      },
    ]
  })
}

function collaborationReceiversOf(value: JsonValue): CollaborationReceiver[] {
  const fields = recordOf(value)
  if (fields === undefined) return []
  const direct = collaborationReceiverOf(fields)
  if (direct !== undefined) return [direct]
  const entries = Array.isArray(fields.updates)
    ? fields.updates
    : Array.isArray(fields.agents)
      ? fields.agents
      : []
  return entries.flatMap((entry) => {
    const receiver = collaborationReceiverOf(recordOf(entry))
    return receiver === undefined ? [] : [receiver]
  })
}

function collaborationReceiverOf(
  fields: Record<string, JsonValue> | undefined,
): CollaborationReceiver | undefined {
  const sessionId = stringOf(fields?.agentId)
  const path = stringOf(fields?.path)
  return sessionId === undefined || path === undefined
    ? undefined
    : { sessionId, path }
}

function stringArrayOf(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined
}

function stringValueOf(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}
