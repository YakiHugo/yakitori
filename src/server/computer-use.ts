import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ComputerUseStatus,
  computerUseServerName,
} from "../protocol/connections.ts"
import { McpClient, McpConnectionError } from "../runtime/mcp-client.ts"
import type { McpServerConfig } from "../runtime/mcp-config.ts"
import type { UserConfigStore } from "./user-config.ts"

export type { ComputerUseStatus } from "../protocol/connections.ts"
export { computerUseServerName } from "../protocol/connections.ts"

export type ComputerUseDiscoveryOptions = Readonly<{
  helperPath?: string
  platform?: string
}>

export class ComputerUseUnavailableError extends Error {}

export const computerModelTools: readonly string[] = ["observe", "input", "app"]
export const computerInternalTool = "internal"

export function computerToolsEnabled(config: McpServerConfig): boolean {
  return computerModelTools.every(
    (name) =>
      !config.disabledTools?.includes(name) &&
      (config.enabledTools === undefined || config.enabledTools.includes(name)),
  )
}

type InstalledComputer = Readonly<{
  command: string
  args: string[]
  enabledTools: string[]
}>

export async function discoverComputerUse(
  options: ComputerUseDiscoveryOptions = {},
): Promise<InstalledComputer | undefined> {
  if ((options.platform ?? process.platform) !== "darwin") return undefined
  const command =
    options.helperPath ??
    process.env.YAKITORI_COMPUTER_EXECUTABLE ??
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
      "dist/native/Yakitori Computer.app/Contents/MacOS/yakitori-computer",
    )
  try {
    await access(command, constants.X_OK)
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return undefined
    throw error
  }
  return { command, args: ["--mcp"], enabledTools: [...computerModelTools] }
}

export async function readComputerUseStatus(
  userConfig: UserConfigStore,
  options: ComputerUseDiscoveryOptions = {},
): Promise<ComputerUseStatus> {
  const installed = await discoverComputerUse(options)
  if (installed === undefined) return unavailableStatus()
  const configured = (await userConfig.readConfiguration()).mcpServers?.[
    computerUseServerName
  ]
  if (configured === undefined || configured.enabled === false)
    return status(false)
  try {
    return status(true, await probeComputerUse(configured))
  } catch (error) {
    if (!(error instanceof McpConnectionError)) throw error
    return {
      ...status(false),
      message:
        "The computer helper could not be reached. Connect again to refresh it.",
    }
  }
}

export async function connectComputerUse(
  userConfig: UserConfigStore,
  options: ComputerUseDiscoveryOptions = {},
): Promise<ComputerUseStatus> {
  const installed = await discoverComputerUse(options)
  if (installed === undefined)
    throw new ComputerUseUnavailableError(
      "Yakitori Computer is unavailable. Build the native helper on macOS before connecting.",
    )
  const snapshot = await userConfig.readSnapshot()
  const permissions = await probeComputerUse(installed, true)
  const version = snapshot.layers.find(
    (layer) => layer.source === "user",
  )?.version
  await userConfig.writeValue({
    keyPath: ["mcp_servers", computerUseServerName],
    value: {
      command: installed.command,
      args: installed.args,
      enabled: true,
      enabled_tools: installed.enabledTools,
    },
    ...(version === undefined ? {} : { expectedVersion: version }),
  })
  return status(true, permissions)
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
    : status(false)
}

async function probeComputerUse(
  config: McpServerConfig,
  requestPermissions = false,
): Promise<NonNullable<ComputerUseStatus["permissions"]>> {
  const client = new McpClient(
    computerUseServerName,
    config,
    () => {},
    () => {},
    () => {},
  )
  try {
    if (!computerToolsEnabled(config))
      throw new McpConnectionError(
        "A computer tool is disabled in configuration.",
        { code: "catalog_invalid" },
      )
    const tools = await client.start()
    const internal = tools.find((tool) => tool.name === computerInternalTool)
    if (
      internal === undefined ||
      !computerModelTools.every((name) =>
        tools.some((tool) => tool.name === name),
      ) ||
      tools.find((tool) => tool.name === "observe")?.annotations
        ?.readOnlyHint !== true
    )
      throw new McpConnectionError(
        "The computer service did not advertise its desktop tools and internal control.",
        { code: "catalog_invalid" },
      )
    const result = await client.bindTool(internal)({
      action: requestPermissions ? "permissions" : "status",
    })
    const permissions = result.structuredContent
    if (
      result.isError ||
      typeof permissions?.accessibility !== "boolean" ||
      typeof permissions.screenRecording !== "boolean"
    )
      throw new McpConnectionError(
        "The computer helper did not report its macOS permissions.",
        { code: "catalog_invalid" },
      )
    return {
      accessibility: permissions.accessibility,
      screenRecording: permissions.screenRecording,
    }
  } finally {
    await client.close()
  }
}

function status(
  connected: boolean,
  permissions?: NonNullable<ComputerUseStatus["permissions"]>,
): ComputerUseStatus {
  return {
    available: true,
    connected,
    backend: "yakitori-native",
    serverName: computerUseServerName,
    tools: connected ? computerModelTools : [],
    ...(permissions === undefined ? {} : { permissions }),
    ...(permissions &&
    (!permissions.accessibility || !permissions.screenRecording)
      ? {
          message:
            "Enable Accessibility and Screen Recording for Yakitori Computer in System Settings, then refresh the connection.",
        }
      : {}),
  }
}

function unavailableStatus(): ComputerUseStatus {
  return {
    available: false,
    connected: false,
    backend: null,
    serverName: computerUseServerName,
    tools: [],
    message: "Yakitori Computer requires macOS and the bundled native helper.",
  }
}
