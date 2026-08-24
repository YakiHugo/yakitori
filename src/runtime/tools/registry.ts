import type { ModelToolDefinition } from "../model.ts"
import type { JsonValue, ToolExecutionDescriptor } from "../../kernel/index.ts"
import type { UserShellEnv } from "../user-shell-env.ts"
import { createEditFileTool } from "./edit-file.ts"
import { createGlobTool } from "./glob.ts"
import { createGrepTool } from "./grep.ts"
import { createMultiAgentTools } from "./multi-agent.ts"
import { createReadFileTool } from "./read-file.ts"
import { createRunCommandTool } from "./run-command.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.ts"
import { createWebFetchTool } from "./web-fetch.ts"
import { createWebSearchTool } from "./web-search.ts"
import { createWriteFileTool } from "./write-file.ts"
import { dynamicToolExecution } from "./execution-descriptors.ts"
import type { ToolPermissionRequest } from "./types.ts"

export type ToolRouter = Readonly<{
  definitions: ReadonlyArray<ModelToolDefinition>
  get(name: string): RuntimeTool | undefined
  describeExecution(name: string, input: JsonValue): ToolExecutionDescriptor
  completeExecution(
    name: string,
    started: ToolExecutionDescriptor,
    output: JsonValue,
    succeeded: boolean,
  ): ToolExecutionDescriptor
  permissionRequest(
    name: string,
    input: unknown,
    context: Readonly<{ workspaceRoot: string }>,
  ): Promise<ToolPermissionRequest | undefined>
  execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>
}>

export type ToolRegistry = Readonly<{
  tools: ReadonlyArray<RuntimeTool>
  definitions(): ReadonlyArray<ModelToolDefinition>
  finalize(enabled: ReadonlySet<string>): ToolRouter
}>

export function createToolRegistry(
  tools: ReadonlyArray<RuntimeTool> = createDefaultTools(),
): ToolRegistry {
  const duplicate = tools.find(
    (tool, index) =>
      tools.findIndex((candidate) => candidate.name === tool.name) !== index,
  )
  if (duplicate !== undefined) {
    throw new Error(`Duplicate tool name: ${duplicate.name}`)
  }
  return {
    tools,
    definitions() {
      return tools.map(toDefinition)
    },
    finalize(enabled) {
      const selected = tools.filter((tool) => enabled.has(tool.name))
      const selectedByName = new Map(selected.map((tool) => [tool.name, tool]))
      return {
        definitions: selected.map(toDefinition),
        get(name) {
          return selectedByName.get(name)
        },
        describeExecution(name, input) {
          return (
            selectedByName.get(name)?.describeExecution?.(input) ??
            dynamicToolExecution()
          )
        },
        completeExecution(name, started, output, succeeded) {
          return (
            selectedByName
              .get(name)
              ?.completeExecution?.(started, output, succeeded) ?? started
          )
        },
        async permissionRequest(name, input, context) {
          const tool = selectedByName.get(name)
          if (tool === undefined) return undefined
          const dynamic = await tool.permission?.(input, context)
          if (dynamic !== undefined) return dynamic
          if (tool.autoAllow) return undefined
          const command =
            typeof input === "object" &&
            input !== null &&
            "command" in input &&
            typeof (input as { command: unknown }).command === "string"
              ? (input as { command: string }).command
              : name
          return {
            kind: "tool",
            action: name,
            subject: command,
            reason:
              "This tool runs with the host user's filesystem, process, environment, and network authority.",
          }
        },
        async execute(name, input, context) {
          const tool = selectedByName.get(name)
          if (tool === undefined) {
            const message = `Unknown or disabled tool: ${name}`
            return {
              ok: false,
              code: "unknown_tool",
              message,
              content: message,
            }
          }
          return tool.execute(input, context)
        },
      }
    },
  }
}

function toDefinition(tool: RuntimeTool): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }
}

export function createDefaultTools(
  input: {
    readonly userShellEnv?: UserShellEnv
    readonly runCommandLog?: (message: string) => void
  } = {},
): ReadonlyArray<RuntimeTool> {
  return [
    createReadFileTool(),
    createGrepTool(),
    createGlobTool(),
    createEditFileTool(),
    createWriteFileTool(),
    createRunCommandTool({
      ...(input.userShellEnv === undefined
        ? {}
        : { userShellEnv: input.userShellEnv }),
      ...(input.runCommandLog === undefined
        ? {}
        : { log: input.runCommandLog }),
    }),
    createWebFetchTool(),
    createWebSearchTool(),
    ...createMultiAgentTools(),
  ]
}

export type {
  RuntimeTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.ts"
