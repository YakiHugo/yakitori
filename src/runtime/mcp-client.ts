import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  type CallToolResult,
  CallToolResultSchema,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  ErrorCode,
  type ListResourcesResult,
  ListResourcesResultSchema,
  type ListResourceTemplatesResult,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  McpError,
  type ReadResourceResult,
  ReadResourceResultSchema,
  type Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import { MAX_MCP_TIMEOUT_MS, type McpServerConfig } from "./mcp-config.ts"
import type { ToolExecutionContext } from "./tools/types.ts"

export type McpToolDescription = Tool

export type McpElicitationHandler = (
  request: Readonly<{
    serverName: string
    params: ElicitRequest["params"]
    context?: ToolExecutionContext
  }>,
  signal: AbortSignal,
) => Promise<ElicitResult>

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
  readonly #client: Client
  readonly #config: McpServerConfig
  readonly #computerUse: boolean
  #activeComputerCalls = 0
  #running = false
  #closing = false
  #close: Promise<void> | undefined
  #lastError: Error | undefined
  #owners = 1
  readonly #lifetime = new AbortController()
  readonly #activeCalls = new Set<ToolExecutionContext>()
  readonly #onExit: (error: McpConnectionError) => void
  readonly #authProvider: OAuthClientProvider | undefined

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
    options: {
      authProvider?: OAuthClientProvider
      onElicitation?: McpElicitationHandler
    } = {},
  ) {
    this.#onExit = onExit
    this.#authProvider = options.authProvider
    this.#config = config
    this.#computerUse = name === "cua_repl"
    this.#client = new Client(
      { name: "yakitori", version: "0.0.0" },
      this.#computerUse || options.onElicitation
        ? { capabilities: { elicitation: { form: {}, url: {} } } }
        : {},
    )
    if (this.#computerUse || options.onElicitation) {
      this.#client.setRequestHandler(
        ElicitRequestSchema,
        async (request, extra) => {
          const params = request.params
          const metadata = params._meta
          const target = metadata?.tool_params
          // Execution has already passed the host permission gate. The native
          // service additionally requests app access; this acceptance lasts only
          // for the current call and never writes Codex's persistent app grants.
          if (
            this.#activeComputerCalls > 0 &&
            params.mode !== "url" &&
            Object.keys(params.requestedSchema.properties).length === 0 &&
            (params.requestedSchema.required?.length ?? 0) === 0 &&
            metadata?.codex_approval_kind === "mcp_tool_call" &&
            metadata.connector_id === "computer-use" &&
            metadata.codex_request_type === undefined &&
            typeof target === "object" &&
            target !== null &&
            "app" in target &&
            typeof target.app === "string" &&
            target.app.trim() !== ""
          ) {
            return {
              action: "accept",
              content: {},
              _meta: { persist: "session" },
            }
          }
          if (!options.onElicitation) return { action: "decline" }
          const active = [...this.#activeCalls]
          const first = active[0]
          let context = active.length === 1 ? active[0] : undefined
          if (
            active.length > 1 &&
            first !== undefined &&
            active.every(
              (call) =>
                call.rolloutId === first.rolloutId &&
                call.turnId === first.turnId,
            )
          ) {
            const {
              toolCallId: _toolCallId,
              signal: _signal,
              ...shared
            } = first
            context = shared
          }
          const signals = [extra.signal, this.#lifetime.signal]
          if (context?.signal) signals.push(context.signal)
          const signal = AbortSignal.any(signals)
          signal.throwIfAborted()
          const result = await options.onElicitation(
            {
              serverName: name,
              params,
              ...(context === undefined ? {} : { context }),
            },
            signal,
          )
          signal.throwIfAborted()
          if (params.mode !== "url" && result.action === "accept") {
            const validate = new AjvJsonSchemaValidator().getValidator(
              params.requestedSchema as JsonSchemaType,
            )
            const validation = validate(result.content ?? {})
            if (!validation.valid)
              throw new McpError(
                ErrorCode.InvalidParams,
                `Invalid elicitation response: ${validation.errorMessage}`,
              )
          }
          return result
        },
      )
    }
    this.#client.onerror = (error) => {
      this.#lastError = error
      this.handleRequestFailure(error)
    }
    this.#client.onclose = () => {
      const wasRunning = this.#running
      this.#running = false
      this.#lifetime.abort()
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

  hasResources(): boolean {
    return this.#client.getServerCapabilities()?.resources !== undefined
  }

  async listResources(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ListResourcesResult> {
    try {
      return await this.#client.request(
        {
          method: "resources/list",
          params: cursor === undefined ? {} : { cursor },
        },
        ListResourcesResultSchema,
        {
          timeout: this.#config.toolTimeoutMs ?? 60_000,
          ...(signal === undefined ? {} : { signal }),
        },
      )
    } catch (error) {
      this.handleRequestFailure(error)
      throw error
    }
  }

  async listResourceTemplates(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ListResourceTemplatesResult> {
    try {
      return await this.#client.request(
        {
          method: "resources/templates/list",
          params: cursor === undefined ? {} : { cursor },
        },
        ListResourceTemplatesResultSchema,
        {
          timeout: this.#config.toolTimeoutMs ?? 60_000,
          ...(signal === undefined ? {} : { signal }),
        },
      )
    } catch (error) {
      this.handleRequestFailure(error)
      throw error
    }
  }

  async readResource(
    uri: string,
    context: ToolExecutionContext,
  ): Promise<ReadResourceResult> {
    const cancellation = new AbortController()
    const activeContext = {
      ...context,
      signal: context.signal
        ? AbortSignal.any([context.signal, cancellation.signal])
        : cancellation.signal,
    }
    this.#activeCalls.add(activeContext)
    try {
      return await this.#client.request(
        { method: "resources/read", params: { uri } },
        ReadResourceResultSchema,
        {
          timeout: this.#config.toolTimeoutMs ?? 60_000,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
      )
    } catch (error) {
      this.handleRequestFailure(error)
      throw error
    } finally {
      cancellation.abort()
      this.#activeCalls.delete(activeContext)
    }
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
            ...(this.#authProvider === undefined
              ? {}
              : { authProvider: this.#authProvider }),
            // Do not forward credentials or tool bodies to redirect destinations.
            fetch: async (input, init) => {
              const response = await fetch(input, {
                ...init,
                redirect: "error",
              })
              // The SDK retries authenticated requests. Only initialization may
              // do that: retire failed calls and authenticate the next connection.
              // Inspect this request, not connection state: another parallel call
              // may already have retired the connection when this response arrives.
              const message: unknown =
                typeof init?.body === "string" && init.body.startsWith("{")
                  ? JSON.parse(init.body)
                  : undefined
              const initializing =
                typeof message === "object" &&
                message !== null &&
                "method" in message &&
                message.method === "initialize"
              if (
                !initializing &&
                (response.status === 401 || response.status === 403)
              )
                throw new UnauthorizedError("MCP authentication is required.")
              return response
            },
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
        (cause instanceof StreamableHTTPError &&
          (cause.code === 401 || cause.code === 403))
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
      const disconnected = isDisconnected(cause)
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
    if (!this.#client.getServerCapabilities()?.tools) return []
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
  ): (
    input: unknown,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ) => Promise<CallToolResult> {
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
    return async (input, signal, context) => {
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
      const computerCall = this.#computerUse && name === "js"
      if (computerCall) this.#activeComputerCalls += 1
      const cancellation = new AbortController()
      const activeContext =
        context === undefined
          ? undefined
          : {
              ...context,
              signal: signal
                ? AbortSignal.any([signal, cancellation.signal])
                : cancellation.signal,
            }
      if (activeContext) this.#activeCalls.add(activeContext)
      let result: CallToolResult
      try {
        result = await this.#client.request(
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
      } catch (error) {
        this.handleRequestFailure(error)
        throw error
      } finally {
        cancellation.abort()
        if (computerCall) this.#activeComputerCalls -= 1
        if (activeContext) this.#activeCalls.delete(activeContext)
      }
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
    this.#lifetime.abort()
    this.#close ??= this.#client.close()
    return this.#close
  }

  handleRequestFailure(cause: unknown): void {
    const authentication =
      cause instanceof UnauthorizedError ||
      (cause instanceof StreamableHTTPError &&
        (cause.code === 401 || cause.code === 403))
    if (!this.#running || (!authentication && !isDisconnected(cause))) return
    this.#running = false
    this.#onExit(
      new McpConnectionError(
        authentication
          ? "MCP authentication is required."
          : "MCP connection was lost; the call was not replayed.",
        {
          cause,
          code: authentication ? "authentication_required" : "disconnected",
          retryable: true,
        },
      ),
    )
    void this.close()
  }
}

function isDisconnected(error: unknown): boolean {
  if (error instanceof McpError)
    return error.code === ErrorCode.ConnectionClosed
  if (error instanceof StreamableHTTPError)
    return (
      error.code === 404 ||
      error.code === 408 ||
      error.code === 429 ||
      (error.code !== undefined && error.code >= 500)
    )
  if (error instanceof TypeError && error.message === "fetch failed")
    return true
  if (error instanceof Error && "code" in error)
    return [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ].includes(String(error.code))
  return false
}
