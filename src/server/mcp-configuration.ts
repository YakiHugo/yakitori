import type { TomlTable } from "smol-toml"
import {
  MAX_MCP_TIMEOUT_MS,
  type McpServerConfig,
} from "../runtime/mcp-config.ts"
import { ConfigurationError } from "./config-errors.ts"

export function mcpServersFromConfig(
  value: TomlTable,
): Readonly<Record<string, McpServerConfig>> | undefined {
  const configured = value.mcp_servers
  if (configured === undefined) return undefined
  if (!isTomlTable(configured)) {
    throw new ConfigurationError("mcp_servers must be a table.")
  }
  return Object.fromEntries(
    Object.entries(configured).map(([name, entry]) => {
      if (name.trim() === "" || !isTomlTable(entry)) {
        throw new ConfigurationError(
          `Invalid MCP server configuration: ${name}`,
        )
      }
      if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
        throw new ConfigurationError(
          `mcp_servers.${name}.enabled must be a boolean.`,
        )
      for (const field of ["startup_timeout_ms", "tool_timeout_ms"]) {
        const value = entry[field]
        if (
          value !== undefined &&
          (typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value <= 0 ||
            value > MAX_MCP_TIMEOUT_MS)
        )
          throw new ConfigurationError(
            `mcp_servers.${name}.${field} must be an integer between 1 and ${MAX_MCP_TIMEOUT_MS} milliseconds.`,
          )
      }
      const common = {
        ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
        ...(entry.startup_timeout_ms === undefined
          ? {}
          : { startupTimeoutMs: entry.startup_timeout_ms as number }),
        ...(entry.tool_timeout_ms === undefined
          ? {}
          : { toolTimeoutMs: entry.tool_timeout_ms as number }),
        ...(entry.enabled_tools === undefined
          ? {}
          : {
              enabledTools:
                stringArrayValue(
                  entry.enabled_tools,
                  `mcp_servers.${name}.enabled_tools`,
                ) ?? [],
            }),
        ...(entry.disabled_tools === undefined
          ? {}
          : {
              disabledTools:
                stringArrayValue(
                  entry.disabled_tools,
                  `mcp_servers.${name}.disabled_tools`,
                ) ?? [],
            }),
      }
      const stdioFields = ["command", "args", "cwd", "env"]
      const httpFields = [
        "url",
        "http_headers",
        "env_http_headers",
        "bearer_token_env_var",
      ]
      const commonFields = [
        "enabled",
        "startup_timeout_ms",
        "tool_timeout_ms",
        "enabled_tools",
        "disabled_tools",
      ]
      const transportFields = entry.url === undefined ? stdioFields : httpFields
      for (const field of Object.keys(entry)) {
        if (![...transportFields, ...commonFields].includes(field))
          throw new ConfigurationError(
            `Unknown or conflicting MCP field: mcp_servers.${name}.${field}`,
          )
      }
      if (entry.url !== undefined) {
        if (typeof entry.url !== "string" || !URL.canParse(entry.url))
          throw new ConfigurationError(
            `mcp_servers.${name}.url must be an HTTP URL.`,
          )
        const url = new URL(entry.url)
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new ConfigurationError(
            `mcp_servers.${name}.url must be an HTTP URL without embedded credentials.`,
          )
        const httpHeaders = stringMapValue(
          entry.http_headers,
          `mcp_servers.${name}.http_headers`,
        )
        const envHttpHeaders = stringMapValue(
          entry.env_http_headers,
          `mcp_servers.${name}.env_http_headers`,
        )
        try {
          new Headers(httpHeaders)
          for (const [header, variable] of Object.entries(
            envHttpHeaders ?? {},
          )) {
            new Headers({ [header]: "" })
            if (variable.trim() === "")
              throw new ConfigurationError(
                `mcp_servers.${name}.env_http_headers must name environment variables.`,
              )
          }
        } catch (cause) {
          if (!(cause instanceof TypeError)) throw cause
          throw new ConfigurationError(
            `mcp_servers.${name} contains an invalid HTTP header.`,
            { cause },
          )
        }
        if (
          entry.bearer_token_env_var !== undefined &&
          (typeof entry.bearer_token_env_var !== "string" ||
            entry.bearer_token_env_var.trim() === "")
        )
          throw new ConfigurationError(
            `mcp_servers.${name}.bearer_token_env_var must name an environment variable.`,
          )
        return [
          name,
          {
            ...common,
            url: entry.url,
            ...(httpHeaders === undefined ? {} : { httpHeaders }),
            ...(envHttpHeaders === undefined ? {} : { envHttpHeaders }),
            ...(entry.bearer_token_env_var === undefined
              ? {}
              : { bearerTokenEnvVar: entry.bearer_token_env_var as string }),
          },
        ]
      }
      if (typeof entry.command !== "string" || entry.command.trim() === "")
        throw new ConfigurationError(`mcp_servers.${name}.command is required.`)
      const args = stringArrayValue(entry.args, `mcp_servers.${name}.args`)
      const env = stringMapValue(entry.env, `mcp_servers.${name}.env`)
      if (entry.cwd !== undefined && typeof entry.cwd !== "string")
        throw new ConfigurationError(
          `mcp_servers.${name}.cwd must be a string.`,
        )
      return [
        name,
        {
          command: entry.command,
          ...(args === undefined ? {} : { args }),
          ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
          ...(env === undefined ? {} : { env }),
          ...common,
        },
      ]
    }),
  )
}

function stringArrayValue(
  value: unknown,
  path: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new ConfigurationError(`${path} must be an array of strings.`)
  }
  return value
}

function stringMapValue(
  value: unknown,
  path: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (
    !isTomlTable(value) ||
    !Object.values(value).every((entry) => typeof entry === "string")
  ) {
    throw new ConfigurationError(`${path} must be a string table.`)
  }
  return value as Record<string, string>
}

function isTomlTable(value: unknown): value is TomlTable {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  )
}
