import type { AgentConfiguration } from "../protocol/configuration.ts"
import type { SessionTaskRunner } from "../core/session-task.ts"
import type { JsonValue } from "../kernel/index.ts"
import {
  createGoalSection,
  createProjectInstructionsSection,
} from "./native-context-sections.ts"
import {
  createProjectInstructionsLoader,
  type loadProjectInstructions,
} from "./project-instructions.ts"
import { createSkillsExtension } from "./skills-extension.ts"
import type {
  SkillConfiguration,
  SkillMcpServer,
  SkillsSource,
} from "./skills.ts"
import { createToolRegistry } from "./tools/registry.ts"
import {
  createTurnLoop,
  type PreparedStepContext,
  type TurnLoopOptions,
} from "./turn-loop.ts"

export type TurnProcessorOptions = Omit<
  TurnLoopOptions,
  "toolRegistry" | "prepareStepContext"
> &
  Readonly<{
    toolRegistry?: TurnLoopOptions["toolRegistry"]
    skills?: boolean
    skillsSource?: SkillsSource
    loadSessionGoal?: () => Promise<
      | Readonly<{
          objective: string
          status?: import("../core/goal.ts").GoalStatus
        }>
      | undefined
    >
    loadProjectInstructions?: typeof loadProjectInstructions
    prepareStepExtensions?: (signal: AbortSignal) => Promise<
      Readonly<{
        agents?: AgentConfiguration
        skills?: SkillConfiguration
        skillMcpServers?: readonly SkillMcpServer[]
        projectRootMarkers?: readonly string[]
        projectInstructionFilenames?: readonly string[]
      }>
    >
  }>

// Native harness composition. The execution loop only accepts prepared context;
// filesystem discovery, skill activation, and goal semantics stay in this owner.
export function createTurnProcessor(
  options: TurnProcessorOptions,
): SessionTaskRunner {
  const {
    toolRegistry,
    skills,
    skillsSource,
    loadSessionGoal,
    loadProjectInstructions,
    prepareStepExtensions,
    ...loopOptions
  } = options
  const loadInstructions =
    loadProjectInstructions ?? createProjectInstructionsLoader()
  const skillExtension = createSkillsExtension({
    ...(skills === undefined ? {} : { enabled: skills }),
    ...(skillsSource === undefined ? {} : { source: skillsSource }),
  })
  return createTurnLoop({
    ...loopOptions,
    toolRegistry: toolRegistry ?? createToolRegistry(),
    async prepareStepContext({
      workingDirectory,
      signal,
    }): Promise<PreparedStepContext> {
      const configuration = (await prepareStepExtensions?.(signal)) ?? {}
      const diagnostics: NonNullable<
        PreparedStepContext["diagnostics"]
      >[number][] = []
      const discovery = {
        workingDirectory,
        ...(configuration.projectRootMarkers === undefined
          ? {}
          : { projectRootMarkers: configuration.projectRootMarkers }),
      }
      const instructions = await loadInstructions({
        ...discovery,
        ...(configuration.projectInstructionFilenames === undefined
          ? {}
          : { fallbackFilenames: configuration.projectInstructionFilenames }),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      })
      const preparedSkills = await skillExtension.prepare({
        ...discovery,
        ...(configuration.skills === undefined
          ? {}
          : { configuration: configuration.skills }),
        ...(configuration.skillMcpServers === undefined
          ? {}
          : { mcpServers: configuration.skillMcpServers }),
      })
      const goal = await loadSessionGoal?.()
      return {
        ...(configuration.agents === undefined
          ? {}
          : { agents: configuration.agents }),
        sections: [
          createProjectInstructionsSection(instructions),
          ...(preparedSkills.sections ?? []),
          createGoalSection(goal?.objective, goal?.status),
        ],
        compactionKey: [
          instructions === undefined
            ? null
            : { directory: instructions.directory, text: instructions.text },
          preparedSkills.compactionKey ?? null,
        ] satisfies JsonValue,
        diagnostics: [...diagnostics, ...(preparedSkills.diagnostics ?? [])],
        ...(preparedSkills.prepareInput === undefined
          ? {}
          : { prepareInput: preparedSkills.prepareInput }),
      }
    },
  })
}
