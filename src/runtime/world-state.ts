import { createHash } from "node:crypto"
import type {
  JsonObject,
  JsonValue,
  WorldStateFragment,
} from "../kernel/index.ts"
import {
  createJsonMergePatch,
  jsonValuesEqual,
} from "../kernel/json-equality.ts"
import type { AgentRuntimeContext } from "./agent-control.ts"
import {
  type EnvironmentSnapshot,
  renderEnvironmentContext,
} from "./environment-context.ts"
import type { ProjectInstructions } from "./project-instructions.ts"
import type { ResolvedStepConfiguration } from "./session-configuration.ts"

export const WorldStateSectionId = {
  Model: "model",
  ProjectInstructions: "project.instructions",
  Environment: "environment",
  MultiAgent: "multi_agent",
} as const

export type PreviousSectionState<T> =
  | { readonly type: "known"; readonly snapshot: T }
  | { readonly type: "absent" }
  | { readonly type: "unknown" }

export type WorldState = Readonly<{
  sections: readonly ErasedWorldStateSection[]
}>

export type WorldStateDiff = Readonly<{
  full: boolean
  state: JsonObject
  snapshot: JsonObject
  fragments: readonly WorldStateFragment[]
}>

type ErasedWorldStateSection = Readonly<{
  id: string
  snapshot: JsonValue
  renderDiff(previous: PreviousSectionState<JsonValue>): WorldStateFragment[]
}>

export function buildWorldStateFromSnapshot(input: {
  readonly configuration: ResolvedStepConfiguration
  readonly enabledToolNames?: ReadonlySet<string>
  readonly baseModelId?: string | undefined
  readonly previousModelId?: string | undefined
  readonly environment: EnvironmentSnapshot
  readonly projectInstructions?: ProjectInstructions
  readonly multiAgent?: AgentRuntimeContext
}): WorldState {
  return {
    sections: [
      modelSection(
        input.configuration,
        input.baseModelId ?? input.previousModelId,
      ),
      ...(input.multiAgent === undefined
        ? []
        : [
            multiAgentSection(
              input.multiAgent,
              (
                input.enabledToolNames ??
                new Set(input.configuration.enabledTools)
              ).has("spawn_agent"),
            ),
          ]),
      projectInstructionsSection(input.projectInstructions),
      environmentSection(input.environment),
    ],
  }
}

function multiAgentSection(
  context: AgentRuntimeContext,
  canSpawnAgent: boolean,
): ErasedWorldStateSection {
  const snapshot: JsonObject = {
    path: context.path,
    taskName: context.taskName,
    agentType: context.agentType,
    depth: context.depth,
    maxDepth: context.maxDepth,
    maxConcurrentAgents: context.maxConcurrentAgents,
    ...(context.parentPath === undefined
      ? {}
      : { parentPath: context.parentPath }),
  }
  return section({
    id: WorldStateSectionId.MultiAgent,
    snapshot,
    decode: jsonObjectSnapshot,
    render(previous) {
      if (previous.type === "known" && equalJson(previous.snapshot, snapshot)) {
        return []
      }
      const role =
        context.agentType === "explore"
          ? "This is an exploration role. Inspect and report; do not modify files or run mutating commands."
          : "Complete the assigned task and report concrete results."
      const delegation = !canSpawnAgent
        ? "No descendant-delegation tool is available in this Step."
        : context.depth >= context.maxDepth
          ? `Delegation depth ${String(context.maxDepth)} has been reached. Do not retry spawn_agent; complete the work yourself.`
          : `You may spawn descendants up to depth ${String(context.maxDepth)} when a bounded task can run independently.`
      return [
        fragment(
          WorldStateSectionId.MultiAgent,
          "developer",
          `<multi_agent_context>\nYou are agent ${context.path}${context.parentPath === undefined ? "." : `, reporting to ${context.parentPath}.`} ${role}\n${delegation}\nThe shared tree allows ${String(context.maxConcurrentAgents)} concurrently running agents including the root. All agents receive the same tool definitions; follow the role guidance above when choosing actions.\n</multi_agent_context>`,
        ),
      ]
    },
  })
}

export function diffWorldState(
  previous: JsonObject | undefined,
  current: WorldState,
): WorldStateDiff | undefined {
  requireUniqueSectionIds(current.sections)
  const currentState = snapshotWorldState(current)
  if (previous === undefined) {
    return {
      full: true,
      state: currentState,
      snapshot: currentState,
      fragments: current.sections.flatMap((section) =>
        section.renderDiff({ type: "absent" }),
      ),
    }
  }

  const patch = createJsonMergePatch(previous, currentState)
  if (patch === undefined) return undefined
  const fragments = current.sections.flatMap((section) =>
    section.renderDiff(previousSection(previous[section.id])),
  )
  return { full: false, state: patch, snapshot: currentState, fragments }
}

export function snapshotWorldState(current: WorldState): JsonObject {
  requireUniqueSectionIds(current.sections)
  return Object.fromEntries(
    current.sections.map((section) => [section.id, section.snapshot]),
  )
}

function modelSection(
  configuration: ResolvedStepConfiguration,
  previousModelId: string | undefined,
): ErasedWorldStateSection {
  const modelId = `${configuration.target.provider}/${configuration.target.model}`
  const snapshot = modelId
  return section({
    id: WorldStateSectionId.Model,
    snapshot,
    decode: stringSnapshot,
    render(previous) {
      const changed =
        previous.type === "known"
          ? previous.snapshot !== modelId
          : previousModelId !== undefined && previousModelId !== modelId
      if (!changed || configuration.modelInstructions.text.length === 0)
        return []
      return [
        fragment(
          WorldStateSectionId.Model,
          "developer",
          `<model_switch>\nThe user was previously using a different model. Continue the conversation according to the following model-specific instructions.\n\n${configuration.modelInstructions.text}\n</model_switch>`,
        ),
      ]
    },
  })
}

type ProjectInstructionsSnapshot = Readonly<{
  directory?: string
  text?: string
}>

function projectInstructionsSection(
  instructions: ProjectInstructions | undefined,
): ErasedWorldStateSection {
  const text = instructions?.text
  const snapshot: ProjectInstructionsSnapshot = {
    ...(instructions === undefined
      ? {}
      : { directory: instructions.directory, text: text ?? "" }),
  }
  return section({
    id: WorldStateSectionId.ProjectInstructions,
    snapshot: snapshot as JsonObject,
    decode: projectInstructionsSnapshot,
    render(previous) {
      if (
        previous.type === "known" &&
        equalJson(previous.snapshot as JsonValue, snapshot as JsonValue)
      ) {
        return []
      }
      const previousMayContainInstructions =
        previous.type === "unknown" ||
        (previous.type === "known" && previous.snapshot.text !== undefined)
      if (text !== undefined) {
        return [
          fragment(
            WorldStateSectionId.ProjectInstructions,
            "user",
            previousMayContainInstructions
              ? `<project_instructions_update>\nThese project instructions replace all previously supplied project instructions.\n\n${text}\n</project_instructions_update>`
              : text,
          ),
        ]
      }
      return previousMayContainInstructions
        ? [
            fragment(
              WorldStateSectionId.ProjectInstructions,
              "user",
              "<project_instructions_update>\nThe previously supplied project instructions no longer apply.\n</project_instructions_update>",
            ),
          ]
        : []
    },
  })
}

function environmentSection(
  environment: EnvironmentSnapshot,
): ErasedWorldStateSection {
  const snapshot = { ...environment }
  const text = renderEnvironmentContext(environment)
  return section({
    id: WorldStateSectionId.Environment,
    snapshot,
    decode: environmentSnapshot,
    render(previous) {
      if (
        previous.type === "known" &&
        equalJson(previous.snapshot as JsonValue, snapshot)
      ) {
        return []
      }
      return [
        fragment(
          WorldStateSectionId.Environment,
          "user",
          previous.type === "absent"
            ? text
            : `<environment_update>\nThe runtime environment changed. Replace the previous environment with the following.\n\n${text}\n</environment_update>`,
        ),
      ]
    },
  })
}

function fragment(
  id: string,
  role: WorldStateFragment["role"],
  text: string,
): WorldStateFragment {
  return { id, role, text, revision: fingerprint(`${role}\0${text}`) }
}

function section<T>(input: {
  readonly id: string
  readonly snapshot: JsonValue
  readonly decode: (value: JsonValue) => T | undefined
  readonly render: (previous: PreviousSectionState<T>) => WorldStateFragment[]
}): ErasedWorldStateSection {
  requireMergePatchSafeSnapshot(input.id, input.snapshot)
  return {
    id: input.id,
    snapshot: input.snapshot,
    renderDiff(previous) {
      if (previous.type !== "known") return input.render(previous)
      const decoded = input.decode(previous.snapshot)
      return input.render(
        decoded === undefined
          ? { type: "unknown" }
          : { type: "known", snapshot: decoded },
      )
    },
  }
}

// RFC 7386 reserves null object fields for deletion, so persisted section
// snapshots must express absence by omitting a field instead.
function requireMergePatchSafeSnapshot(id: string, value: JsonValue): void {
  if (Array.isArray(value)) return
  if (!isJsonRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (child === null) {
      throw new Error(
        `World-state section ${id} contains null field ${key}; omit it instead.`,
      )
    }
    requireMergePatchSafeSnapshot(id, child)
  }
}

function previousSection(
  value: JsonValue | undefined,
): PreviousSectionState<JsonValue> {
  return value === undefined
    ? { type: "absent" }
    : { type: "known", snapshot: value }
}

function stringSnapshot(value: JsonValue): string | undefined {
  return typeof value === "string" ? value : undefined
}

function jsonObjectSnapshot(value: JsonValue): JsonObject | undefined {
  return isJsonRecord(value) ? value : undefined
}

function projectInstructionsSnapshot(
  value: JsonValue,
): ProjectInstructionsSnapshot | undefined {
  if (!isJsonRecord(value)) return undefined
  const directory = value.directory
  const text = value.text
  if (
    (directory !== undefined && typeof directory !== "string") ||
    (text !== undefined && typeof text !== "string")
  ) {
    return undefined
  }
  return {
    ...(directory === undefined ? {} : { directory }),
    ...(text === undefined ? {} : { text }),
  }
}

function environmentSnapshot(
  value: JsonValue,
): EnvironmentSnapshot | undefined {
  if (!isJsonRecord(value)) return undefined
  const keys = [
    "workspaceRoot",
    "workingDirectory",
    "platform",
    "osVersion",
    "currentDate",
    "timezone",
  ] as const
  if (
    !keys.every((key) => typeof value[key] === "string") ||
    typeof value.isGitRepository !== "boolean"
  ) {
    return undefined
  }
  return value as EnvironmentSnapshot
}

function equalJson(left: JsonValue | undefined, right: JsonValue): boolean {
  return left !== undefined && jsonValuesEqual(left, right)
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireUniqueSectionIds(
  sections: readonly ErasedWorldStateSection[],
): void {
  const ids = new Set<string>()
  for (const section of sections) {
    if (ids.has(section.id)) {
      throw new Error(`Duplicate world-state section ID: ${section.id}`)
    }
    ids.add(section.id)
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
