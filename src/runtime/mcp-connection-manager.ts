import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import type { JsonObject, JsonValue } from "../kernel/index.ts"
import type { McpServerConfig } from "./mcp-config.ts"
import type { RuntimeTool } from "./tools/types.ts"

export type { McpServerConfig } from "./mcp-config.ts"

const MCP_PROTOCOL_VERSION = "2025-06-18"

export type McpServerStatus = Readonly<{
  name: string
  state: "ready" | "failed" | "stopped"
  toolCount: number
  error?: string
}>

export type McpConnectionManager = Readonly<{
  update(configs: Readonly<Record<string, McpServerConfig>>): Promise<void>
  tools(): readonly RuntimeTool[]
  status(): readonly McpServerStatus[]
  subscribe(
    listener: (serverName: string, tools: readonly RuntimeTool[]) => void,
  ): () => void
  close(): Promise<void>
}>

type McpToolDescription = Readonly<{
  name: string
  description?: string
  inputSchema: JsonObject
  annotations?: Readonly<{ readOnlyHint?: boolean }>
}>

type Connection = Readonly<{
  fingerprint: string
  client: StdioMcpClient
  tools: readonly RuntimeTool[]
}>

export function createMcpConnectionManager(
  options: { readonly restartDelayMs?: number } = {},
): McpConnectionManager {
  const connections = new Map<string, Connection>()
  const failures = new Map<string, string>()
  const configuredServers = new Map<string, McpServerConfig>()
  const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const listeners = new Set<
    (serverName: string, tools: readonly RuntimeTool[]) => void
  >()
  const restartDelayMs = options.restartDelayMs ?? 250
  let closed = false

  const publish = (name: string, tools: readonly RuntimeTool[]) => {
    for (const listener of listeners) listener(name, tools)
  }

  const scheduleRestart = (name: string, identity: string) => {
    if (closed || restartTimers.has(name)) return
    const timer = setTimeout(() => {
      restartTimers.delete(name)
      const config = configuredServers.get(name)
      if (config === undefined || fingerprint(config) !== identity) return
      void connect(name, config, identity)
    }, restartDelayMs)
    timer.unref()
    restartTimers.set(name, timer)
  }

  const connect = async (
    name: string,
    config: McpServerConfig,
    identity: string,
  ): Promise<void> => {
    const client = new StdioMcpClient(name, config, (error) => {
      const current = connections.get(name)
      if (current?.client !== client) return
      connections.delete(name)
      failures.set(name, error.message)
      publish(name, [])
      scheduleRestart(name, identity)
    })
    try {
      const descriptions = await client.start()
      if (closed || configuredServers.get(name) !== config) {
        await client.close()
        return
      }
      const tools = descriptions.map((tool) => runtimeTool(name, client, tool))
      connections.set(name, { fingerprint: identity, client, tools })
      failures.delete(name)
      publish(name, tools)
    } catch (error) {
      failures.set(name, error instanceof Error ? error.message : String(error))
      await client.close()
      scheduleRestart(name, identity)
    }
  }

  return {
    async update(configs) {
      if (closed) throw new Error("MCP connection manager is closed.")
      const enabled = Object.entries(configs).filter(
        ([, config]) => config.enabled !== false,
      )
      const keep = new Set(enabled.map(([name]) => name))
      for (const [name, timer] of restartTimers) {
        if (keep.has(name)) continue
        clearTimeout(timer)
        restartTimers.delete(name)
      }
      await Promise.all(
        [...connections.entries()].flatMap(([name, connection]) =>
          keep.has(name) ? [] : [connection.client.close()],
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
      }

      for (const [name, config] of enabled) {
        requireServerName(name)
        const identity = fingerprint(config)
        configuredServers.set(name, config)
        const current = connections.get(name)
        if (current?.fingerprint === identity && current.client.isRunning()) {
          continue
        }
        if (current !== undefined) {
          await current.client.close()
          connections.delete(name)
        }
        await connect(name, config, identity)
      }
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
          error,
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
      await Promise.all(
        [...connections.values()].map((connection) =>
          connection.client.close(),
        ),
      )
      connections.clear()
      configuredServers.clear()
      listeners.clear()
    },
  }
}

class StdioMcpClient {
  readonly #name: string
  readonly #config: McpServerConfig
  readonly #onExit: (error: Error) => void
  #process: ChildProcessWithoutNullStreams | undefined
  #nextId = 1
  #buffer = ""
  readonly #pending = new Map<
    number,
    Readonly<{
      resolve(value: unknown): void
      reject(error: unknown): void
    }>
  >()
  #stderr = ""
  #closing = false

  constructor(
    name: string,
    config: McpServerConfig,
    onExit: (error: Error) => void,
  ) {
    this.#name = name
    this.#config = config
    this.#onExit = onExit
  }

  isRunning(): boolean {
    return this.#process !== undefined && this.#process.exitCode === null
  }

  async start(): Promise<readonly McpToolDescription[]> {
    if (this.#process !== undefined)
      throw new Error("MCP client already started.")
    this.#closing = false
    const child = spawn(this.#config.command, [...(this.#config.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.#config.cwd === undefined ? {} : { cwd: this.#config.cwd }),
      env: { ...process.env, ...(this.#config.env ?? {}) },
    })
    this.#process = child
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.#receive(chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_192)
    })
    let exitReported = false
    const reportExit = (error: Error) => {
      if (exitReported) return
      exitReported = true
      if (this.#process === child) this.#process = undefined
      this.#failPending(error)
      if (!this.#closing) this.#onExit(error)
    }
    child.once("error", reportExit)
    child.once("exit", (code, signal) => {
      reportExit(
        new Error(
          `MCP server ${this.#name} exited (${signal ?? String(code)}).${this.#stderr.trim() === "" ? "" : ` ${this.#stderr.trim()}`}`,
        ),
      )
    })

    const timeoutMs = this.#config.startupTimeoutMs ?? 10_000
    await this.#request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "yakitori", version: "0.0.0" },
      },
      timeoutMs,
    )
    this.#notify("notifications/initialized", {})
    const listed = await this.#request("tools/list", {}, timeoutMs)
    return parseToolList(listed, this.#name)
  }

  callTool(
    name: string,
    input: JsonValue,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#request(
      "tools/call",
      { name, arguments: input },
      60_000,
      signal,
    )
  }

  async close(): Promise<void> {
    this.#closing = true
    const child = this.#process
    this.#process = undefined
    if (child === undefined || child.exitCode !== null) return
    child.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
        resolve()
      }, 1_000)
      timeout.unref()
      child.once("exit", () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  #request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`MCP ${this.#name} ${method} timed out.`))
      }, timeoutMs)
      timeout.unref()
      const onAbort = () => {
        this.#pending.delete(id)
        clearTimeout(timeout)
        reject(new DOMException("The operation was aborted.", "AbortError"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          signal?.removeEventListener("abort", onAbort)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      try {
        this.#send({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timeout)
        signal?.removeEventListener("abort", onAbort)
        reject(error)
      }
    })
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params })
  }

  #send(message: unknown): void {
    if (!this.isRunning() || this.#process === undefined) {
      throw new Error(`MCP server ${this.#name} is not running.`)
    }
    this.#process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #receive(chunk: string): void {
    this.#buffer += chunk
    while (true) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line === "") continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(message) || typeof message.id !== "number") continue
      const pending = this.#pending.get(message.id)
      if (pending === undefined) continue
      this.#pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(
          new Error(`MCP ${this.#name}: ${JSON.stringify(message.error)}`),
        )
      } else {
        pending.resolve(message.result)
      }
    }
  }

  #failPending(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

function runtimeTool(
  serverName: string,
  client: StdioMcpClient,
  tool: McpToolDescription,
): RuntimeTool {
  return {
    toolName: { namespace: serverName, name: tool.name },
    description: tool.description ?? `MCP tool ${serverName}/${tool.name}`,
    inputSchema: tool.inputSchema,
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
      const result = await client.callTool(
        tool.name,
        asJsonValue(input),
        context.signal,
      )
      const parsed = asJsonValue(result)
      const failed = isRecord(result) && result.isError === true
      const content = mcpContent(result)
      return failed
        ? {
            ok: false,
            code: "mcp_tool_error",
            message: content,
            content,
            output: parsed,
          }
        : { ok: true, content, output: parsed }
    },
  }
}

function parseToolList(
  value: unknown,
  serverName: string,
): readonly McpToolDescription[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new Error(
      `MCP server ${serverName} returned an invalid tools/list result.`,
    )
  }
  return value.tools.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !isRecord(entry.inputSchema)
    ) {
      throw new Error(
        `MCP server ${serverName} returned an invalid tool definition.`,
      )
    }
    return {
      name: entry.name,
      ...(typeof entry.description === "string"
        ? { description: entry.description }
        : {}),
      inputSchema: asJsonObject(entry.inputSchema),
      ...(isRecord(entry.annotations)
        ? {
            annotations: {
              ...(typeof entry.annotations.readOnlyHint === "boolean"
                ? { readOnlyHint: entry.annotations.readOnlyHint }
                : {}),
            },
          }
        : {}),
    }
  })
}

function mcpContent(value: unknown): string {
  if (isRecord(value) && Array.isArray(value.content)) {
    const text = value.content
      .flatMap((entry) =>
        isRecord(entry) &&
        entry.type === "text" &&
        typeof entry.text === "string"
          ? [entry.text]
          : [],
      )
      .join("\n")
    if (text !== "") return text
  }
  return JSON.stringify(value)
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function requireServerName(name: string): void {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return
  throw new Error(`Invalid MCP server name: ${name}`)
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
