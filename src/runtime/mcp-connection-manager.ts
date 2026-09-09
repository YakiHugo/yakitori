import { mcpResult } from "./tools/mcp-result.ts"
import {
  McpClient,
  McpConnectionError,
  type McpToolDescription,
} from "./mcp-client.ts"
import { createHash } from "node:crypto"
import type { JsonObject, JsonValue } from "../kernel/index.ts"
import type { McpServerConfig } from "./mcp-config.ts"
import type { ToolName } from "./tools/tool-name.ts"
import type { RuntimeTool } from "./tools/types.ts"

export type { McpServerConfig } from "./mcp-config.ts"

export type McpServerStatus = Readonly<{
  name: string
  state: "ready" | "failed" | "stopped"
  toolCount: number
  error?: string
  errorCode?: McpConnectionError["code"]
}>

export type McpConnectionManager = Readonly<{
  update(
    configs: Readonly<Record<string, McpServerConfig>>,
    signal?: AbortSignal,
  ): Promise<void>
  tools(): readonly RuntimeTool[]
  status(): readonly McpServerStatus[]
  subscribe(
    listener: (serverName: string, tools: readonly RuntimeTool[]) => void,
  ): () => void
  close(): Promise<void>
}>

type Connection = Readonly<{
  fingerprint: string
  client: McpClient
  tools: readonly RuntimeTool[]
}>

export function createMcpConnectionManager(
  options: {
    readonly restartDelayMs?: number
    readonly maxRestartDelayMs?: number
    readonly maxRestartAttempts?: number
    readonly onBackgroundError?: (error: unknown) => void
    readonly installTools?: (
      name: string,
      tools: readonly RuntimeTool[],
    ) => void
  } = {},
): McpConnectionManager {
  const allocateServerName = createModelNameAllocator()
  const connections = new Map<string, Connection>()
  const failures = new Map<string, McpConnectionError>()
  const configuredServers = new Map<string, McpServerConfig>()
  const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const restartAttempts = new Map<string, number>()
  const generations = new Map<string, number>()
  const connecting = new Map<
    string,
    Readonly<{
      fingerprint: string
      generation: number
      promise: Promise<void>
    }>
  >()
  const clients = new Set<McpClient>()
  const refreshing = new Map<McpClient, boolean>()
  const refreshTasks = new Set<Promise<void>>()
  let updateQueue = Promise.resolve()
  const listeners = new Set<
    (serverName: string, tools: readonly RuntimeTool[]) => void
  >()
  const restartDelayMs = options.restartDelayMs ?? 250
  const maxRestartDelayMs = options.maxRestartDelayMs ?? 30_000
  const maxRestartAttempts = options.maxRestartAttempts ?? 5
  let closed = false

  const reportBackgroundError = (error: unknown) => {
    if (options.onBackgroundError) options.onBackgroundError(error)
    else console.error("MCP background operation failed", error)
  }
  const publish = (
    name: string,
    tools: readonly RuntimeTool[],
    commit: () => void = () => {},
  ) => {
    options.installTools?.(name, tools)
    commit()
    for (const listener of listeners) {
      try {
        listener(name, tools)
      } catch (error) {
        reportBackgroundError(error)
      }
    }
  }

  const scheduleRestart = (
    name: string,
    identity: string,
    generation: number,
  ) => {
    if (closed || restartTimers.has(name)) return
    const attempt = (restartAttempts.get(name) ?? 0) + 1
    if (attempt > maxRestartAttempts) return
    restartAttempts.set(name, attempt)
    const delay = Math.min(
      restartDelayMs * 2 ** Math.max(0, attempt - 1),
      maxRestartDelayMs,
    )
    const timer = setTimeout(() => {
      restartTimers.delete(name)
      const config = configuredServers.get(name)
      if (
        config === undefined ||
        fingerprint(config) !== identity ||
        generations.get(name) !== generation
      ) {
        return
      }
      void connect(name, config, identity, generation).catch(
        (error: unknown) => {
          reportBackgroundError(error)
        },
      )
    }, delay)
    timer.unref()
    restartTimers.set(name, timer)
  }

  const connect = async (
    name: string,
    config: McpServerConfig,
    identity: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    const active = connecting.get(name)
    if (active?.generation === generation) return active.promise
    const promise = connectOnce(name, config, identity, generation, signal)
    connecting.set(name, { fingerprint: identity, generation, promise })
    await promise.finally(() => {
      if (connecting.get(name)?.promise === promise) connecting.delete(name)
    })
  }

  const connectOnce = async (
    name: string,
    config: McpServerConfig,
    identity: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    const names = {
      namespace: allocateServerName(name),
      tool: createModelNameAllocator(),
    }
    let initialized = false
    let refreshPending = false
    const refresh = () => {
      if (!initialized) {
        refreshPending = true
        return
      }

      if (connections.get(name)?.client !== client) return
      if (refreshing.has(client)) {
        refreshing.set(client, true)
        return
      }
      refreshing.set(client, true)
      const task = (async () => {
        try {
          while (refreshing.get(client) === true && !closed) {
            refreshing.set(client, false)
            const descriptions = await client.listTools()
            if (connections.get(name)?.client !== client) return
            const tools = makeTools(name, client, descriptions, config, names)
            publish(name, tools, () =>
              connections.set(name, { fingerprint: identity, client, tools }),
            )
          }
        } finally {
          refreshing.delete(client)
        }
      })().catch((error: unknown) => {
        if (!closed) reportBackgroundError(error)
      })
      refreshTasks.add(task)
      void task.finally(() => refreshTasks.delete(task))
    }
    const client = new McpClient(
      name,
      config,
      (error) => {
        clients.delete(client)
        const current = connections.get(name)
        if (
          current?.client !== client ||
          generations.get(name) !== generation
        ) {
          return
        }
        connections.delete(name)
        failures.set(name, error)
        publish(name, [])
        scheduleRestart(name, identity, generation)
      },
      refresh,
      () => {
        clients.delete(client)
      },
    )
    clients.add(client)
    try {
      const descriptions = await client.start(signal)
      if (
        closed ||
        generations.get(name) !== generation ||
        fingerprint(configuredServers.get(name) ?? {}) !== identity
      ) {
        await client.close()
        clients.delete(client)
        return
      }
      if (!client.isRunning())
        throw new McpConnectionError(
          "MCP server disconnected during discovery.",
          { code: "disconnected", retryable: true },
        )
      const tools = makeTools(name, client, descriptions, config, names)
      publish(name, tools, () => {
        connections.set(name, { fingerprint: identity, client, tools })
        failures.delete(name)
      })
      initialized = true
      if (refreshPending) refresh()
    } catch (error) {
      await client.close()
      clients.delete(client)
      if (generations.get(name) !== generation) return
      signal?.throwIfAborted()
      if (!(error instanceof McpConnectionError)) throw error
      failures.set(name, error)
      if (error.retryable) scheduleRestart(name, identity, generation)
    }
  }

  const update = async (
    configs: Readonly<Record<string, McpServerConfig>>,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted()
    if (closed) throw new Error("MCP connection manager is closed.")
    const enabled = Object.entries(configs).filter(
      ([, config]) => config.enabled !== false,
    )
    const keep = new Set(enabled.map(([name]) => name))
    for (const [name, timer] of restartTimers) {
      clearTimeout(timer)
      restartTimers.delete(name)
    }
    await Promise.all(
      [...connections.entries()].flatMap(([name, connection]) =>
        keep.has(name) ? [] : [connection.client.release()],
      ),
    )
    for (const name of [...connections.keys()]) {
      if (!keep.has(name)) {
        connections.delete(name)
        publish(name, [])
      }
    }
    for (const name of [...failures.keys()]) {
      if (!keep.has(name)) failures.delete(name)
    }
    for (const name of [...configuredServers.keys()]) {
      if (!keep.has(name)) configuredServers.delete(name)
      if (!keep.has(name)) {
        generations.set(name, (generations.get(name) ?? 0) + 1)
        restartAttempts.delete(name)
      }
    }

    await Promise.all(
      enabled.map(async ([name, config]) => {
        const identity = fingerprint(config)
        configuredServers.set(name, config)
        const current = connections.get(name)
        if (current?.fingerprint === identity && current.client.isRunning()) {
          return
        }
        const pending = connecting.get(name)
        if (pending?.fingerprint === identity) {
          await pending.promise
          return
        }
        restartAttempts.delete(name)
        const generation = (generations.get(name) ?? 0) + 1
        generations.set(name, generation)
        if (current !== undefined) {
          await current.client.release()
          connections.delete(name)
          publish(name, [])
        }
        await connect(name, config, identity, generation, signal)
      }),
    )
  }

  return {
    update(configs, signal) {
      const pending = updateQueue.then(() => update(configs, signal))
      // A rejected update remains visible to its caller; the queue must still
      // allow a later corrected configuration to be applied.
      updateQueue = pending.catch(() => {})
      return pending
    },
    tools() {
      return [...connections.values()].flatMap((connection) => connection.tools)
    },
    status() {
      return [
        ...[...connections.entries()].map(
          ([name, connection]) =>
            ({
              name,
              state: connection.client.isRunning() ? "ready" : "stopped",
              toolCount: connection.tools.length,
            }) satisfies McpServerStatus,
        ),
        ...[...failures.entries()].map(([name, error]) => ({
          name,
          state: "failed" as const,
          toolCount: 0,
          error: error.message,
          errorCode: error.code,
        })),
      ].sort((left, right) => left.name.localeCompare(right.name))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      if (closed) return
      closed = true
      for (const timer of restartTimers.values()) clearTimeout(timer)
      restartTimers.clear()
      await Promise.all([...clients].map((client) => client.close()))
      await Promise.allSettled(
        [...connecting.values()].map((connection) => connection.promise),
      )
      await Promise.allSettled([...refreshTasks])
      connections.clear()
      configuredServers.clear()
      connecting.clear()
      generations.clear()
      failures.clear()
      clients.clear()
      listeners.clear()
    },
  }
}

function runtimeTool(
  serverName: string,
  client: McpClient,
  tool: McpToolDescription,
  toolName: ToolName,
): RuntimeTool {
  const call = client.bindTool(tool)
  return {
    toolName,
    exposure: "deferred",
    search: { source: serverName, searchText: `${serverName} ${tool.name}` },
    description: tool.description ?? `MCP tool ${serverName}/${tool.name}`,
    inputSchema: asJsonObject(tool.inputSchema),
    effect: tool.annotations?.readOnlyHint === true ? "observe" : "opaque",
    approvalRequirement:
      tool.annotations?.readOnlyHint === true
        ? { kind: "none" }
        : {
            kind: "approval",
            action: "command_execution",
            subject: `${serverName}/${tool.name}`,
            reason: "The MCP tool may have external side effects.",
          },
    async execute(input, context) {
      const result = await call(asJsonValue(input), context.signal)
      return mcpResult(asJsonValue(result), context)
    },
    dispose: () => client.release(),
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

// Canonical names must also fit providers with a 64-byte combined tool-name
// limit. Keep protocol identity separate from this multi-provider adaptation.
function modelName(raw: string): string {
  if (
    /^[A-Za-z0-9-](?:[A-Za-z0-9_-]*[A-Za-z0-9-])?$/.test(raw) &&
    !raw.includes("__") &&
    raw.length <= 30
  )
    return raw
  const base =
    raw
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 19)
      .replace(/_+$/g, "") || "tool"
  return `${base}_${createHash("sha256").update(raw).digest("hex").slice(0, 10)}`
}

// Allocate against the final names, including legal names that happen to equal
// a generated hash name. Keep allocations stable while old Steps still use them.
function createModelNameAllocator(): (raw: string) => string {
  const assigned = new Map<string, string>()
  const used = new Set<string>()
  return (raw) => {
    const existing = assigned.get(raw)
    if (existing !== undefined) return existing
    const base = modelName(raw)
    let name = base
    for (let attempt = 1; used.has(name); attempt++) {
      const hash = createHash("sha256")
        .update(`${raw}:${attempt}`)
        .digest("hex")
        .slice(0, 10)
      name = `${base.slice(0, 19).replace(/_+$/, "")}_${hash}`
    }
    assigned.set(raw, name)
    used.add(name)
    return name
  }
}

function makeTools(
  name: string,
  client: McpClient,
  descriptions: readonly McpToolDescription[],
  config: McpServerConfig,
  names: Readonly<{ namespace: string; tool: (raw: string) => string }>,
): readonly RuntimeTool[] {
  const seen = new Set<string>()
  const tools = descriptions.flatMap((tool) => {
    if (
      seen.has(tool.name) ||
      config.disabledTools?.includes(tool.name) ||
      (config.enabledTools !== undefined &&
        !config.enabledTools.includes(tool.name))
    )
      return []
    seen.add(tool.name)
    return [
      runtimeTool(name, client, tool, {
        namespace: names.namespace,
        name: names.tool(tool.name),
      }),
    ]
  })
  // Prepare the complete catalog before taking ownership; schema compilation
  // can fail and must not retain a partially constructed set of tools.
  tools.forEach(() => {
    client.retain()
  })
  return tools
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw new Error("Expected a JSON object.")
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]),
  )
}

function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value
  }
  if (Array.isArray(value)) return value.map(asJsonValue)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]),
    )
  }
  throw new Error("MCP value is not JSON-compatible.")
}
