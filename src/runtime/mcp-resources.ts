import type { JsonValue } from "../kernel/index.ts"
import type { McpClient } from "./mcp-client.ts"
import { mcpResult } from "./tools/mcp-result.ts"
import type { RuntimeTool } from "./tools/types.ts"

export function mcpResourceTools(
  serverName: string,
  client: McpClient,
  names: Readonly<{
    namespace: string
    tool(raw: string, identity?: string): string
  }>,
): RuntimeTool[] {
  if (!client.hasResources()) return []
  return (
    ["list_resources", "list_resource_templates", "read_resource"] as const
  ).map((operation) => ({
    toolName: {
      namespace: names.namespace,
      name: names.tool(operation, `host:${operation}`),
    },
    exposure: "deferred",
    search: {
      source: serverName,
      searchText: `${serverName} MCP resources ${operation}`,
    },
    description:
      operation === "read_resource"
        ? `Read a resource URI from MCP server ${serverName}. Use a URI from list_resources or expand a URI template from list_resource_templates.`
        : `List ${operation === "list_resources" ? "resources" : "resource URI templates"} from MCP server ${serverName}. Pass nextCursor as cursor to retrieve the next page.`,
    inputSchema: {
      type: "object",
      properties:
        operation === "read_resource"
          ? {
              uri: { type: "string", description: "The resource URI to read." },
            }
          : {
              cursor: {
                type: "string",
                description: "The nextCursor from the previous page.",
              },
            },
      required: operation === "read_resource" ? ["uri"] : [],
      additionalProperties: false,
    },
    effect: "observe",
    supportsParallelToolCalls: true,
    approvalRequirement: { kind: "none" },
    async execute(input, context) {
      context.signal?.throwIfAborted()
      if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new Error("MCP resource arguments must be an object.")
      if (operation === "read_resource") {
        if (
          !("uri" in input) ||
          typeof input.uri !== "string" ||
          input.uri.length === 0
        )
          throw new Error("MCP resource URI must be a nonempty string.")
        const result = await client.readResource(input.uri, context)
        return mcpResult(
          {
            content: result.contents.map((resource) => ({
              type: "resource",
              resource,
            })) as JsonValue[],
            ...(result._meta === undefined
              ? {}
              : { _meta: result._meta as JsonValue }),
          },
          context,
        )
      }
      const cursor = "cursor" in input ? input.cursor : undefined
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" || Buffer.byteLength(cursor) > 64 * 1024)
      )
        throw new Error(
          "MCP resource cursor must be a string within the host 64 KiB framing boundary.",
        )
      const result =
        operation === "list_resources"
          ? await client.listResources(cursor, context.signal)
          : await client.listResourceTemplates(cursor, context.signal)
      // Protocol metadata is UI-only, just as for tools/call results.
      const { _meta, ...content } = result
      return mcpResult(
        {
          content: [{ type: "text", text: JSON.stringify(content) }],
          ...(_meta === undefined ? {} : { _meta: _meta as JsonValue }),
        },
        context,
      )
    },
    dispose: () => client.release(),
  }))
}
