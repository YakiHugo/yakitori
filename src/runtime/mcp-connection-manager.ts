import { createHash } from "node:crypto"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { JsonObject, JsonValue } from "../kernel/index.ts"
import {
  McpClient,
  McpConnectionError,
  type McpElicitationHandler,
  type McpToolDescription,
} from "./mcp-client.ts"
import type { McpServerConfig } from "./mcp-config.ts"
import { mcpResourceTools } from "./mcp-resources.ts"
import { mcpResult } from "./tools/mcp-result.ts"
import type { ToolName } from "./tools/tool-name.ts"
import type { RuntimeTool, ToolExecutionContext } from "./tools/types.ts"

export type { McpServerConfig } from "./mcp-config.ts"

export type McpServerStatus = Readonly<{
  name: string
  state: "ready" | "failed" | "stopped" | "connecting"
  toolCount: number
  required: boolean
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
  // Waits for in-flight optional connections up to a shared deadline so a
  // Step snapshot usually includes servers that are nearly ready (codex-rs
  // optional_mcp_startup_grace). Required servers are already awaited by
  // update(); a required server reconnecting mid-session is awaited here.
  settleConnecting(timeoutMs: number, signal?: AbortSignal): Promise<void>
  reconnect(name: string): Promise<void>
  subscribe(
    listener: (serverName: string, tools: readonly RuntimeTool[]) => void,
  ): () => void
  subscribeStatus(listener: () => void): () => void
  finishTurn(): Promise<void>
  close(): Promise<void>
}>

type Connection = Readonly<{
  fingerprint: string
  client: McpClient
  tools: readonly RuntimeTool[]
}>

export function createMcpConnectionManager(
  options: Readonly<{
    restartDelayMs?: number
    maxRestartDelayMs?: number
    maxRestartAttempts?: number
    onBackgroundError?: (error: unknown) => void
    onElicitation?: McpElicitationHandler
    authProvider?: (
      name: string,
      config: McpServerConfig,
    ) => OAuthClientProvider | undefined
    installTools?: (name: string, tools: readonly RuntimeTool[]) => void
    turnEndTools?: Readonly<
      Record<
        string,
        Readonly<{
          name: string
          input(context: ToolExecutionContext): JsonObject
        }>
      >
    >
  }> = {},
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
  const turnCleanups = new Map<McpClient, () => Promise<void>>()
  const refreshing = new Map<McpClient, boolean>()
  const refreshTasks = new Set<Promise<void>>()
  let updateQueue = Promise.resolve()
  const listeners = new Set<
    (serverName: string, tools: readonly RuntimeTool[]) => void
  >()
  const statusListeners = new Set<() => void>()
  const restartDelayMs = options.restartDelayMs ?? 250
  const maxRestartDelayMs = options.maxRestartDelayMs ?? 30_000
  const maxRestartAttempts = options.maxRestartAttempts ?? 5
  let closed = false

  const finishTurn = async () => {
    const cleanups = [...turnCleanups.values()]
    turnCleanups.clear()
    const results = await Promise.allSettled(
      cleanups.map((cleanup) => cleanup()),
    )
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    )
    if (errors.length > 0)
      throw new AggregateError(errors, "MCP turn cleanup failed.")
  }

  const reportBackgroundError = (error: unknown) => {
    if (options.onBackgroundError) options.onBackgroundError(error)
    else console.error("MCP background operation failed", error)
  }
  const notifyStatus = () => {
    for (const listener of statusListeners) {
      try {
        listener()
      } catch (error) {
        reportBackgroundError(error)
      }
    }
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
    notifyStatus()
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
    notifyStatus()
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
    let turnEndTool: McpToolDescription | undefined
    const markUsed = (context: ToolExecutionContext) => {
      if (!turnEndTool || turnCleanups.has(client)) return
      const call = client.bindTool(turnEndTool)
      const hook = options.turnEndTools?.[name]
      if (!hook) return
      // Hold the exact connection until cleanup even if config changes retire
      // it between steps. A replacement connection cannot release its state.
      client.retain()
      turnCleanups.set(client, async () => {
        try {
          const result = await call(hook.input(context))
          if (result.isError)
            throw new McpConnectionError(`MCP turn cleanup failed for ${name}.`)
        } finally {
          await client.release()
        }
      })
    }
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
            turnEndTool = descriptions.find(
              (tool) => tool.name === options.turnEndTools?.[name]?.name,
            )
            const tools = makeTools(
              name,
              client,
              descriptions,
              config,
              names,
              markUsed,
            )
            publish(name, tools, () =>
              connections.set(name, { fingerprint: identity, client, tools }),
            )
          }
        } finally {
          refreshing.delete(client)
        }
      })().catch((error: unknown) => {
        client.handleRequestFailure(error)
        if (!closed) reportBackgroundError(error)
      })
      refreshTasks.add(task)
      void task.finally(() => refreshTasks.delete(task))
    }
    const authProvider = options.authProvider?.(name, config)
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
        if (error.retryable) scheduleRestart(name, identity, generation)
      },
      refresh,
      () => {
        clients.delete(client)
      },
      {
        ...(options.onElicitation === undefined
          ? {}
          : { onElicitation: options.onElicitation }),
        ...(authProvider === undefined ? {} : { authProvider }),
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
      turnEndTool = descriptions.find(
        (tool) => tool.name === options.turnEndTools?.[name]?.name,
      )
      const tools = makeTools(
        name,
        client,
        descriptions,
        config,
        names,
        markUsed,
      )
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
      notifyStatus()
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

    // Required servers are awaited and fail the caller when they cannot
    // connect; optional servers connect in the background so a slow or
    // broken integration never stalls Session creation or a config reload.
    // Background connects deliberately do not inherit the caller's signal: a
    // Turn-scoped abort must not cancel a connection other Steps still need.
    const requiredTasks: Promise<void>[] = []
    for (const [name, config] of enabled) {
      const identity = fingerprint(config)
      configuredServers.set(name, config)
      const current = connections.get(name)
      if (current?.fingerprint === identity && current.client.isRunning()) {
        continue
      }
      const pending = connecting.get(name)
      if (pending?.fingerprint === identity) {
        if (config.required === true) requiredTasks.push(pending.promise)
        continue
      }
      restartAttempts.delete(name)
      const generation = (generations.get(name) ?? 0) + 1
      generations.set(name, generation)
      if (current !== undefined) {
        await current.client.release()
        connections.delete(name)
        publish(name, [])
      }
      const task = connect(
        name,
        config,
        identity,
        generation,
        config.required === true ? signal : undefined,
      )
      if (config.required === true) {
        requiredTasks.push(task)
      } else {
        void task.catch((error: unknown) => {
          if (closed) return
          if (generations.get(name) === generation) {
            failures.set(
              name,
              error instanceof McpConnectionError
                ? error
                : new McpConnectionError(
                    error instanceof Error ? error.message : String(error),
                  ),
            )
            notifyStatus()
          }
          reportBackgroundError(error)
        })
      }
    }
    await Promise.all(requiredTasks)
    const requiredFailures = enabled.flatMap(([name, config]) => {
      if (config.required !== true) return []
      const failure = failures.get(name)
      return failure === undefined ? [] : [`${name}: ${failure.message}`]
    })
    if (requiredFailures.length > 0) {
      throw new Error(
        `Required MCP servers failed to connect: ${requiredFailures.join("; ")}`,
      )
    }
  }

  return {
    update(configs, signal) {
      const pending = updateQueue.then(() => update(configs, signal))
      // A rejected update remains visible to its caller; the queue must still
      // allow a later corrected configuration to be applied.
      updateQueue = pending.catch(() => {})
      return pending
    },
    reconnect(name) {
      const pending = updateQueue.then(async () => {
        if (closed) throw new Error("MCP connection manager is closed.")
        const config = configuredServers.get(name)
        if (config === undefined) return
        const timer = restartTimers.get(name)
        if (timer) clearTimeout(timer)
        restartTimers.delete(name)
        restartAttempts.delete(name)
        const generation = (generations.get(name) ?? 0) + 1
        generations.set(name, generation)
        const current = connections.get(name)
        if (current) {
          await current.client.release()
          connections.delete(name)
          publish(name, [])
        }
        await connect(name, config, fingerprint(config), generation)
      })
      updateQueue = pending.catch(() => {})
      return pending
    },
    tools() {
      return [...connections.values()].flatMap((connection) => connection.tools)
    },
    status() {
      const required = (name: string) =>
        configuredServers.get(name)?.required === true
      return [
        ...[...connections.entries()].map(
          ([name, connection]) =>
            ({
              name,
              state: connection.client.isRunning() ? "ready" : "stopped",
              toolCount: connection.tools.length,
              required: required(name),
            }) satisfies McpServerStatus,
        ),
        ...[...failures.entries()].map(([name, error]) => ({
          name,
          state: "failed" as const,
          toolCount: 0,
          required: required(name),
          error: error.message,
          errorCode: error.code,
        })),
        ...[...connecting.keys()].flatMap((name) =>
          connections.has(name) || failures.has(name)
            ? []
            : [
                {
                  name,
                  state: "connecting" as const,
                  toolCount: 0,
                  required: required(name),
                },
              ],
        ),
      ].sort((left, right) => left.name.localeCompare(right.name))
    },
    async settleConnecting(timeoutMs, signal) {
      signal?.throwIfAborted()
      const pending = [...connecting.entries()]
      if (pending.length === 0) return
      // Failures surface through status(); settling is only a wait.
      const settled = (promise: Promise<void>) => promise.catch(() => {})
      const requiredWaits = pending
        .filter(([name]) => configuredServers.get(name)?.required === true)
        .map(([, entry]) => settled(entry.promise))
      const optionalWaits = pending
        .filter(([name]) => configuredServers.get(name)?.required !== true)
        .map(([, entry]) => settled(entry.promise))
      const waits: Promise<unknown>[] = [...requiredWaits]
      let timer: ReturnType<typeof setTimeout> | undefined
      if (optionalWaits.length > 0) {
        waits.push(
          Promise.race([
            Promise.allSettled(optionalWaits),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, timeoutMs)
              timer.unref()
            }),
          ]),
        )
      }
      let onAbort: (() => void) | undefined
      try {
        if (signal === undefined) {
          await Promise.all(waits)
        } else {
          await Promise.race([
            Promise.all(waits),
            new Promise<never>((_, reject) => {
              onAbort = () => {
                try {
                  signal.throwIfAborted()
                } catch (error) {
                  reject(error)
                }
              }
              signal.addEventListener("abort", onAbort, { once: true })
              if (signal.aborted) onAbort()
            }),
          ])
        }
      } finally {
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort)
        if (timer !== undefined) clearTimeout(timer)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeStatus(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    finishTurn,
    async close() {
      if (closed) return
      closed = true
      for (const timer of restartTimers.values()) clearTimeout(timer)
      restartTimers.clear()
      const cleanup = await Promise.allSettled([finishTurn()])
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
      if (cleanup[0]?.status === "rejected") throw cleanup[0].reason
    },
  }
}

function runtimeTool(
  serverName: string,
  client: McpClient,
  tool: McpToolDescription,
  toolName: ToolName,
  markUsed: (context: ToolExecutionContext) => void,
): RuntimeTool {
  const call = client.bindTool(tool)
  return {
    toolName,
    exposure: "deferred",
    search: { source: serverName, searchText: `${serverName} ${tool.name}` },
    description: tool.description ?? `MCP tool ${serverName}/${tool.name}`,
    inputSchema: asJsonObject(tool.inputSchema),
    effect: tool.annotations?.readOnlyHint === true ? "observe" : "opaque",
    supportsParallelToolCalls: tool.annotations?.readOnlyHint === true,
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
      markUsed(context)
      const result = await call(asJsonValue(input), context.signal, context)
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
function createModelNameAllocator(): (
  raw: string,
  identity?: string,
) => string {
  const assigned = new Map<string, string>()
  const used = new Set<string>()
  return (raw, identity) => {
    const key = JSON.stringify([
      identity === undefined ? "remote" : "host",
      identity ?? raw,
    ])
    const existing = assigned.get(key)
    if (existing !== undefined) return existing
    const base = modelName(raw)
    let name = base
    for (let attempt = 1; used.has(name); attempt++) {
      const hash = createHash("sha256")
        .update(`${key}:${attempt}`)
        .digest("hex")
        .slice(0, 10)
      name = `${base.slice(0, 19).replace(/_+$/, "")}_${hash}`
    }
    assigned.set(key, name)
    used.add(name)
    return name
  }
}

function makeTools(
  name: string,
  client: McpClient,
  descriptions: readonly McpToolDescription[],
  config: McpServerConfig,
  names: Readonly<{
    namespace: string
    tool: (raw: string, identity?: string) => string
  }>,
  markUsed: (context: ToolExecutionContext) => void,
): readonly RuntimeTool[] {
  const seen = new Set<string>()
  const resourceTools = mcpResourceTools(name, client, names)
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
      runtimeTool(
        name,
        client,
        tool,
        { namespace: names.namespace, name: names.tool(tool.name) },
        markUsed,
      ),
    ]
  })
  // Prepare the complete catalog before taking ownership; schema compilation
  // can fail and must not retain a partially constructed set of tools.
  tools.push(...resourceTools)
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
