import type { ModelToolDefinition } from "../model.ts"
import { createReadFileTool } from "./read-file.ts"
import { createRunCommandTool } from "./run-command.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.ts"
import { createWriteFileTool } from "./write-file.ts"

export type ToolRegistry = {
  readonly tools: readonly RuntimeTool[]
  get(name: string): RuntimeTool | undefined
  definitions(): readonly ModelToolDefinition[]
  execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>
}

export function createToolRegistry(
  tools: readonly RuntimeTool[] = [
    createReadFileTool(),
    createWriteFileTool(),
    createRunCommandTool(),
  ],
): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    tools,
    get(name) {
      return byName.get(name)
    },
    definitions() {
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
    },
    async execute(name, input, context) {
      const tool = byName.get(name)
      if (!tool) {
        return {
          ok: false,
          code: "unknown_tool",
          message: `Unknown tool: ${name}`,
          content: `Unknown tool: ${name}`,
        }
      }
      return tool.execute(input, context)
    },
  }
}

export type {
  RuntimeTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.ts"
