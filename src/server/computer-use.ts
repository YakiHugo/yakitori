import { constants } from "node:fs"
import { access, readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { McpClient, McpConnectionError } from "../runtime/mcp-client.ts"
import type { McpServerConfig } from "../runtime/mcp-config.ts"
import type { UserConfigStore } from "./user-config.ts"

export const computerUseServerName = "cua_repl"

export type ComputerUseStatus = Readonly<{
  available: boolean
  connected: boolean
  backend: "codex-unified" | null
  serverName: typeof computerUseServerName
  tools: readonly string[]
  message?: string
}>

export type ComputerUseDiscoveryOptions = Readonly<{
  codexHome?: string
  platform?: string
}>

type InstalledComputer = Readonly<{
  command: string
  args: string[]
  env: Record<string, string>
  startupTimeoutMs: number
  enabledTools: readonly string[]
}>

export class ComputerUseUnavailableError extends Error {}

// The first-party plugin owns the OS driver and its API. Yakitori owns tool
// execution through its existing MCP client; no second agent loop is started.
export async function discoverComputerUse(
  options: ComputerUseDiscoveryOptions = {},
): Promise<InstalledComputer | undefined> {
  if ((options.platform ?? process.platform) !== "darwin") return undefined
  const codexHome =
    options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")
  const cache = join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "unified-computer-use",
  )
  const entries = await readdir(cache, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (missingFile(error)) return []
      throw error
    },
  )
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    )
  for (const version of versions) {
    const manifest: unknown = JSON.parse(
      await readFile(join(cache, version, ".mcp.json"), "utf8"),
    )
    const server = object(object(manifest)?.mcpServers)?.cua_repl
    const config = object(server)
    if (
      config === undefined ||
      typeof config.command !== "string" ||
      !isAbsolute(config.command) ||
      !Array.isArray(config.args) ||
      !config.args.every(
        (argument): argument is string => typeof argument === "string",
      )
    ) {
      continue
    }
    const env = object(config.env)
    if (
      env === undefined ||
      !Object.values(env).every((value) => typeof value === "string")
    ) {
      continue
    }
    const executablePresent = await access(config.command, constants.X_OK).then(
      () => true,
      (error: unknown) => {
        if (missingFile(error)) return false
        throw error
      },
    )
    if (!executablePresent) continue
    return {
      command: config.command,
      args: config.args,
      env: {
        ...(env as Record<string, string>),
        CUA_REPL_ENABLED_SURFACES: "computer",
      },
      // Match the installed plugin's documented startup allowance.
      startupTimeoutMs:
        typeof config.startup_timeout_sec === "number"
          ? config.startup_timeout_sec * 1_000
          : 120_000,
      enabledTools: ["js", "js_reset"],
    }
  }
  return undefined
}

export async function readComputerUseStatus(
  userConfig: UserConfigStore,
  options: ComputerUseDiscoveryOptions = {},
): Promise<ComputerUseStatus> {
  const installed = await discoverComputerUse(options)
  const configured = (await userConfig.readConfiguration()).mcpServers?.[
    computerUseServerName
  ]
  if (installed === undefined) return unavailableStatus()
  if (configured === undefined || configured.enabled === false) {
    return status(false, [])
  }
  try {
    return status(true, await probeComputerUse(configured))
  } catch (error) {
    if (!(error instanceof McpConnectionError)) throw error
    return {
      ...status(false, []),
      message:
        "The configured computer service could not be reached. Connect again to refresh it.",
    }
  }
}

export async function connectComputerUse(
  userConfig: UserConfigStore,
  options: ComputerUseDiscoveryOptions = {},
): Promise<ComputerUseStatus> {
  const installed = await discoverComputerUse(options)
  if (installed === undefined) {
    throw new ComputerUseUnavailableError(
      "Install Codex Computer Use on this Mac before connecting.",
    )
  }
  const snapshot = await userConfig.readSnapshot()
  const tools = await probeComputerUse(installed)
  const version = snapshot.layers.find(
    (layer) => layer.source === "user",
  )?.version
  await userConfig.writeValue({
    keyPath: ["mcp_servers", computerUseServerName],
    value: {
      command: installed.command,
      args: installed.args,
      env: installed.env,
      enabled: true,
      startup_timeout_ms: installed.startupTimeoutMs,
      enabled_tools: installed.enabledTools,
    },
    ...(version === undefined ? {} : { expectedVersion: version }),
  })
  return status(true, tools)
}

export async function disconnectComputerUse(
  userConfig: UserConfigStore,
  options: ComputerUseDiscoveryOptions = {},
): Promise<ComputerUseStatus> {
  const snapshot = await userConfig.readSnapshot()
  if (
    snapshot.configuration.mcpServers?.[computerUseServerName] !== undefined
  ) {
    const version = snapshot.layers.find(
      (layer) => layer.source === "user",
    )?.version
    await userConfig.writeValue({
      keyPath: ["mcp_servers", computerUseServerName, "enabled"],
      value: false,
      ...(version === undefined ? {} : { expectedVersion: version }),
    })
  }
  return (await discoverComputerUse(options)) === undefined
    ? unavailableStatus()
    : status(false, [])
}

export async function probeComputerUse(
  config: McpServerConfig,
): Promise<readonly string[]> {
  const client = new McpClient(
    computerUseServerName,
    config,
    () => {},
    () => {},
    () => {},
  )
  try {
    const tools = await client.start()
    if (!tools.some((tool) => tool.name === "js")) {
      throw new McpConnectionError(
        "The computer service did not advertise its desktop tool.",
        {
          code: "catalog_invalid",
        },
      )
    }
    return tools
      .filter(
        (tool) =>
          (config.enabledTools === undefined ||
            config.enabledTools.includes(tool.name)) &&
          !config.disabledTools?.includes(tool.name),
      )
      .map((tool) => tool.name)
  } finally {
    await client.close()
  }
}

function status(
  connected: boolean,
  tools: readonly string[],
): ComputerUseStatus {
  return {
    available: true,
    connected,
    backend: "codex-unified",
    serverName: computerUseServerName,
    tools,
  }
}

function unavailableStatus(): ComputerUseStatus {
  return {
    available: false,
    connected: false,
    backend: null,
    serverName: computerUseServerName,
    tools: [],
    message: "Codex Computer Use is not installed on this Mac.",
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function missingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  )
}
