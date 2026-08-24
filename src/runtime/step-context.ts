import { observeEnvironment } from "./environment-context.ts"
import type { AgentRuntimeContext } from "./agent-control.ts"
import type { SessionProjection } from "../kernel/index.ts"
import { loadProjectInstructions } from "./project-instructions.ts"
import type { TurnContext } from "./session-configuration.ts"
import { resolveWorkspaceRoot } from "./tools/path-policy.ts"
import type { ToolRegistry, ToolRouter } from "./tools/registry.ts"
import { buildWorldState, type WorldState } from "./world-state.ts"

export type StepToolPlan = ToolRouter

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
  const tools = input.toolRegistry.finalize(
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
