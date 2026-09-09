import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  ToolListChangedNotificationSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  type CallToolResult,
  McpError,
  ErrorCode,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { MAX_MCP_TIMEOUT_MS, type McpServerConfig } from "./mcp-config.ts"
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"

export type McpToolDescription = Tool

export class McpConnectionError extends Error {
  readonly code:
    | "initialization_failed"
    | "catalog_invalid"
    | "authentication_required"
    | "disconnected"
    | "timeout"
  readonly retryable: boolean
  constructor(
    message: string,
    options: ErrorOptions & {
      code?: McpConnectionError["code"]
      retryable?: boolean
    } = {},
  ) {
    super(message, options)
    this.name = "McpConnectionError"
    this.code = options.code ?? "initialization_failed"
    this.retryable = options.retryable ?? false
  }
}

// Host safety boundaries, following Codex's bounded discovery. They bound
// untrusted catalogs and framing memory, not the number of user integrations.
const MAX_CATALOG_PAGES = 100
const MAX_CATALOG_TOOLS = 2_048
const MAX_CURSOR_BYTES = 64 * 1024
const MAX_STDIO_BUFFER_BYTES = 8 * 1024 * 1024

export class McpClient {
  readonly #client = new Client({ name: "yakitori", version: "0.0.0" })
  readonly #config: McpServerConfig
  #running = false
  #closing = false
  #close: Promise<void> | undefined
  #lastError: Error | undefined
  #owners = 1

  retain(): void {
    this.#owners++
  }

  async release(): Promise<void> {
    if (--this.#owners === 0) await this.close()
  }

  constructor(
    name: string,
    config: McpServerConfig,
    onExit: (error: McpConnectionError) => void,
    onToolsChanged: () => void,
    onClosed: () => void,
  ) {
    this.#config = config
    this.#client.onerror = (error) => {
      this.#lastError = error
    }
    this.#client.onclose = () => {
      const wasRunning = this.#running
      this.#running = false
      onClosed()
      if (!this.#closing && wasRunning)
        onExit(
          new McpConnectionError(`MCP server ${name} disconnected.`, {
            cause: this.#lastError,
            code: "disconnected",
            retryable: true,
          }),
        )
    }
    this.#client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      onToolsChanged,
    )
  }

  isRunning(): boolean {
    return this.#running
  }

  async start(cancellation?: AbortSignal): Promise<readonly Tool[]> {
    cancellation?.throwIfAborted()
    const config = this.#config
    for (const value of [config.startupTimeoutMs, config.toolTimeoutMs]) {
      if (
        value !== undefined &&
        (!Number.isInteger(value) || value < 1 || value > MAX_MCP_TIMEOUT_MS)
      )
        throw new McpConnectionError(
          "MCP timeout is outside the host timer range.",
        )
    }
    const timeout = config.startupTimeoutMs ?? 10_000
    const deadline = AbortSignal.timeout(timeout)
    const signal =
      cancellation === undefined
        ? deadline
        : AbortSignal.any([deadline, cancellation])
    try {
      if ("command" in config) {
        const transport = new StdioClientTransport({
          command: config.command,
          args: [...(config.args ?? [])],
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          env: Object.fromEntries(
            Object.entries({ ...process.env, ...config.env }).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          stderr: "pipe",
          maxBufferSize: MAX_STDIO_BUFFER_BYTES,
        })
        // Drain stderr without exposing arbitrary server output as a protocol error.
        transport.stderr?.on("data", () => {})
        await this.#client.connect(transport, { signal, timeout })
      } else {
        const headers = new Headers(config.httpHeaders)
        for (const [header, variable] of Object.entries(
          config.envHttpHeaders ?? {},
        )) {
          const value = process.env[variable]
          if (value === undefined)
            throw new McpConnectionError(
              `MCP header environment variable ${variable} is not set.`,
            )
          headers.set(header, value)
        }
        if (config.bearerTokenEnvVar !== undefined) {
          const token = process.env[config.bearerTokenEnvVar]
          if (token === undefined)
            throw new McpConnectionError(
              `MCP bearer token environment variable ${config.bearerTokenEnvVar} is not set.`,
            )
          headers.set("Authorization", `Bearer ${token}`)
        }
        const transport = new StreamableHTTPClientTransport(
          new URL(config.url),
          {
            requestInit: { headers },
            // Do not forward credentials or tool bodies to redirect destinations.
            fetch: (input, init) =>
              fetch(input, { ...init, redirect: "error" }),
          },
        )
        // SDK declarations do not enable exactOptionalPropertyTypes: its
        // sessionId getter returns undefined until initialization.
        await this.#client.connect(transport as Transport, { signal, timeout })
      }
      this.#running = true
      return await this.listTools(signal)
    } catch (cause) {
      if (cause instanceof McpConnectionError) throw cause
      if (
        cause instanceof UnauthorizedError ||
        (cause instanceof StreamableHTTPError && cause.code === 401)
      )
        throw new McpConnectionError("MCP authentication is required.", {
          cause,
          code: "authentication_required",
        })
      if (
        signal.aborted ||
        (cause instanceof McpError && cause.code === ErrorCode.RequestTimeout)
      )
        throw new McpConnectionError("MCP initialization timed out.", {
          cause,
          code: "timeout",
          retryable: true,
        })
      const disconnected =
        cause instanceof McpError && cause.code === ErrorCode.ConnectionClosed
      throw new McpConnectionError("MCP initialization failed.", {
        cause,
        code: disconnected ? "disconnected" : "initialization_failed",
        retryable: disconnected,
      })
    }
  }

  async listTools(
    signal = AbortSignal.timeout(this.#config.startupTimeoutMs ?? 10_000),
  ): Promise<readonly Tool[]> {
    const tools: Tool[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
      signal.throwIfAborted()
      const result = await this.#client.request(
        {
          method: "tools/list",
          params: cursor === undefined ? {} : { cursor },
        },
        ListToolsResultSchema,
        { signal },
      )
      if (result.tools.length > MAX_CATALOG_TOOLS - tools.length)
        throw new McpConnectionError(
          "MCP catalog exceeds the host tool-count safety boundary.",
          { code: "catalog_invalid" },
        )
      tools.push(...result.tools)
      cursor = result.nextCursor
      if (cursor === undefined) return tools
      if (Buffer.byteLength(cursor) > MAX_CURSOR_BYTES || cursors.has(cursor))
        throw new McpConnectionError(
          "MCP catalog returned an oversized or repeated cursor.",
          { code: "catalog_invalid" },
        )
      cursors.add(cursor)
    }
    throw new McpConnectionError(
      "MCP catalog exceeds the host pagination safety boundary.",
      { code: "catalog_invalid" },
    )
  }

  // Like Codex PreparedMcpCall, each RuntimeTool owns its invocation metadata.
  // SDK listTools/callTool mutate/read a shared latest-catalog cache, so use
  // its protocol and schema primitives without that mutable convenience layer.
  bindTool(
    tool: Tool,
  ): (input: unknown, signal?: AbortSignal) => Promise<CallToolResult> {
    const name = tool.name
    const requiresTask = tool.execution?.taskSupport === "required"
    // Isolate schema IDs between tools and revisions, as well as the validator.
    // SDK Tool and validator declarations disagree under exactOptionalPropertyTypes.
    let validate: JsonSchemaValidator<unknown> | undefined
    if (tool.outputSchema !== undefined) {
      try {
        validate = new AjvJsonSchemaValidator().getValidator(
          tool.outputSchema as JsonSchemaType,
        )
      } catch (cause) {
        throw new McpConnectionError(
          `MCP tool ${name} has an invalid output schema.`,
          { code: "catalog_invalid", cause },
        )
      }
    }
    return async (input, signal) => {
      signal?.throwIfAborted()
      if (requiresTask)
        throw new McpError(
          ErrorCode.InvalidRequest,
          `MCP tool ${name} requires task-based execution, which is not supported.`,
        )
      if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new McpError(
          ErrorCode.InvalidParams,
          "MCP tool arguments must be an object.",
        )
      // A failed side-effecting call is never automatically replayed.
      const result = await this.#client.request(
        {
          method: "tools/call",
          params: { name, arguments: input as Record<string, unknown> },
        },
        CallToolResultSchema,
        {
          timeout: this.#config.toolTimeoutMs ?? 60_000,
          ...(signal === undefined ? {} : { signal }),
        },
      )
      if (validate !== undefined) {
        if (result.structuredContent === undefined && !result.isError)
          throw new McpError(
            ErrorCode.InvalidRequest,
            `MCP tool ${name} did not return its declared structured output.`,
          )
        if (result.structuredContent !== undefined) {
          const validation = validate(result.structuredContent)
          if (!validation.valid)
            throw new McpError(
              ErrorCode.InvalidParams,
              `MCP tool ${name} returned invalid structured output: ${validation.errorMessage}`,
            )
        }
      }
      return result
    }
  }

  close(): Promise<void> {
    this.#closing = true
    this.#running = false
    this.#close ??= this.#client.close()
    return this.#close
  }
}
