import { observeEnvironment } from "./environment-context.ts"
import type { AgentRuntimeContext } from "./agent-control.ts"
import type { SessionProjection } from "../kernel/index.ts"
import type { ModelToolDefinition } from "./model.ts"
import { loadProjectInstructions } from "./project-instructions.ts"
import type { TurnContext } from "./session-configuration.ts"
import { resolveWorkspaceRoot } from "./tools/path-policy.ts"
import type { ToolRegistry } from "./tools/registry.ts"
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./tools/types.ts"
import { buildWorldState, type WorldState } from "./world-state.ts"

export type StepToolPlan = Readonly<{
  definitions: readonly ModelToolDefinition[]
  get(name: string): RuntimeTool | undefined
  execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>
}>

export type StepContext = Readonly<{
  turn: TurnContext
  worldState: WorldState
  tools: StepToolPlan
  workspaceRoot: string
}>

export async function captureStepContext(input: {
  readonly turn: TurnContext
  readonly session: SessionProjection
  readonly toolRegistry: ToolRegistry
  readonly projectInstructionLoader?: typeof loadProjectInstructions
  readonly now?: Date
  readonly multiAgent?: AgentRuntimeContext
}): Promise<StepContext> {
  const workspaceRoot = await resolveWorkspaceRoot(
    input.turn.configuration.workspaceRoot,
  )
  const projectInstructions = await (
    input.projectInstructionLoader ?? loadProjectInstructions
  )({
    workspaceRoot,
    workingDirectory: input.turn.configuration.workspaceRoot,
  })
  const tools = createStepToolPlan(
    input.toolRegistry,
    new Set(input.turn.configuration.enabledTools),
  )
  const environment = observeEnvironment({
    workspaceRoot,
    workingDirectory: input.turn.configuration.workspaceRoot,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return {
    turn: input.turn,
    worldState: buildWorldState({
      configuration: input.turn.configuration,
      session: input.session,
      environment,
      ...(input.multiAgent === undefined
        ? {}
        : { multiAgent: input.multiAgent }),
      ...(projectInstructions === undefined ? {} : { projectInstructions }),
    }),
    tools,
    workspaceRoot,
  }
}

function createStepToolPlan(
  registry: ToolRegistry,
  enabled: ReadonlySet<string>,
): StepToolPlan {
  const tools = registry.tools.filter((tool) => enabled.has(tool.name))
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    definitions: tools.map(toDefinition),
    get(name) {
      return byName.get(name)
    },
    async execute(name, input, context) {
      const tool = byName.get(name)
      if (tool === undefined) {
        return {
          ok: false,
          code: "unknown_tool",
          message: `Unknown or disabled tool: ${name}`,
          content: `Unknown or disabled tool: ${name}`,
        }
      }
      return tool.execute(input, context)
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
