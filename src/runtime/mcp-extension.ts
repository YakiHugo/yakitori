import {
  createMcpConnectionManager,
  type McpServerConfig,
} from "./mcp-connection-manager.ts"
import type { ToolRegistry } from "./tools/registry.ts"
import type { RuntimeTool } from "./tools/types.ts"

type ManagerOptions = NonNullable<
  Parameters<typeof createMcpConnectionManager>[0]
>

export type McpServerAvailability = Readonly<{
  name: string
  url?: string
  available: boolean
  reason?: string
}>

// Optional built-in capability. The manager owns protocol connections; this
// owner mounts their tools into the normal permission/execution pipeline.
export function createMcpExtension(
  options: Readonly<{
    registry: ToolRegistry
    connection?: Omit<ManagerOptions, "installTools">
    mapTools?: (
      name: string,
      tools: readonly RuntimeTool[],
    ) => readonly RuntimeTool[]
  }>,
) {
  const sources = new Set<string>()
  let closing: Promise<void> | undefined
  let configuration: string | undefined
  const manager = createMcpConnectionManager({
    ...options.connection,
    installTools(name, tools) {
      if (closing !== undefined) return
      const source = `mcp:${name}`
      options.registry.replaceExternalSource(
        source,
        options.mapTools?.(name, tools) ?? tools,
      )
      sources.add(source)
    },
  })
  const update = async (
    configs: Readonly<Record<string, McpServerConfig>>,
    signal?: AbortSignal,
  ) => {
    if (closing !== undefined) throw new Error("MCP extension is closed.")
    const fingerprint = JSON.stringify(configs)
    if (fingerprint === configuration) return
    await manager.update(configs, signal)
    configuration = fingerprint
  }
  return {
    manager,
    update,
    async prepare(
      configs: Readonly<Record<string, McpServerConfig>>,
      signal?: AbortSignal,
    ): Promise<readonly McpServerAvailability[]> {
      await update(configs, signal)
      // Shared readiness grace, following Codex's optional MCP startup grace.
      await manager.settleConnecting(1_000, signal)
      const status = new Map(
        manager.status().map((server) => [server.name, server]),
      )
      return Object.entries(configs).map(([name, config]) => {
        const current = status.get(name)
        return {
          name,
          ...("url" in config ? { url: config.url } : {}),
          available: current?.state === "ready",
          ...(current?.error === undefined ? {} : { reason: current.error }),
        }
      })
    },
    close() {
      closing ??= Promise.resolve().then(async () => {
        // Quiesce publishers and withdraw tools before the host disposes the
        // registry. A late tools/list reply must not repopulate that registry.
        const results = await Promise.allSettled([
          manager.close(),
          ...[...sources].map((source) =>
            Promise.resolve().then(() => {
              options.registry.replaceExternalSource(source, [])
            }),
          ),
        ])
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        )
        if (errors.length > 0)
          throw new AggregateError(errors, "Failed to close MCP extension.")
      })
      return closing
    },
  }
}
