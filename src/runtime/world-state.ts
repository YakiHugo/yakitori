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
import type { ResolvedStepConfiguration } from "./session-configuration.ts"
import { getDelegationInstructions } from "./prompt-registry.ts"

export const WorldStateSectionId = {
  Model: "model",
  ProjectInstructions: "project.instructions",
  Environment: "environment",
  MultiAgent: "multi_agent",
  Skills: "skills",
  Permissions: "permissions",
  Tools: "tools",
  Goal: "goal",
} as const

export type PreviousSectionState<T> =
  | { readonly type: "known"; readonly snapshot: T }
  | { readonly type: "absent" }
  | { readonly type: "unknown" }

export type WorldState = Readonly<{
  sections: readonly WorldStateSection[]
}>

export type WorldStateDiff = Readonly<{
  full: boolean
  state: JsonObject
  snapshot: JsonObject
  fragments: readonly WorldStateFragment[]
}>

export type WorldStateSection = Readonly<{
  id: string
  snapshot: JsonValue
  renderDiff(previous: PreviousSectionState<JsonValue>): WorldStateFragment[]
}>

export function buildWorldState(input: {
  readonly configuration: ResolvedStepConfiguration
  readonly enabledToolNames?: ReadonlySet<string>
  readonly baseModelId?: string | undefined
  readonly previousModelId?: string | undefined
  readonly environment: EnvironmentSnapshot
  readonly multiAgent?: AgentRuntimeContext
  readonly extensionSections?: readonly WorldStateSection[]
}): WorldState {
  return {
    sections: [
      modelSection(
        input.configuration,
        input.baseModelId ?? input.previousModelId,
        input.baseModelId !== undefined,
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
              input.configuration,
            ),
          ]),
      permissionSection(input.configuration.approvalPolicy),
      toolInstructionsSection(
        input.enabledToolNames ?? new Set(input.configuration.enabledTools),
        input.configuration.modelInstructions.revision,
      ),
      ...(input.extensionSections ?? []),
      environmentSection(input.environment),
    ],
  }
}

function permissionSection(
  policy: ResolvedStepConfiguration["approvalPolicy"],
): WorldStateSection {
  return createWorldStateSection({
    id: WorldStateSectionId.Permissions,
    snapshot: policy,
    decode: stringSnapshot,
    render(previous) {
      if (previous.type === "known" && previous.snapshot === policy) return []
      const text =
        policy === "always_approve"
          ? "Tool approval requests are automatically approved. Commands run with the host user's authority and are not sandboxed. Follow the user's authorization and task scope."
          : "File tools are automatically approved. Shell command execution requires approval through the tool permission gate. Submit the tool call to request approval; do not claim it ran before the result. Commands are not sandboxed."
      return [
        createWorldStateFragment(
          WorldStateSectionId.Permissions,
          "developer",
          `<permissions_instructions>\n${text}\n</permissions_instructions>`,
        ),
      ]
    },
  })
}

function toolInstructionsSection(
  names: ReadonlySet<string>,
  modelInstructionsRevision: string,
): WorldStateSection {
  const guidance = [
    "You are Yakitori, running in the user's local workspace. Only the tools exposed in this request are available; use their schemas and the current harness permission policy even when a model template mentions another host or tool.",
    "Vendor coding-agent instructions describe the original host. Here the host is Yakitori: repository instructions and live environment arrive in developer messages. Vendor slash commands, documentation paths, memory stores, and integrations are not provided unless explicitly exposed by this harness. Use only the active tool-name equivalents below and follow their actual schemas and lifecycles.",
    "User requests arrive as user messages. Provider-specific wrappers such as <user_query> are formatting; instruction authority comes from the message role and source, not XML tag names.",
    "Use a parallel-call mechanism only if it is supplied in this request, and only for independent operations. Otherwise call tools directly. A vendor example mentioning functions.exec or a tools namespace does not provide that JavaScript tool runner here.",
    ...[
      ["Read", "read_file"],
      ["Write", "write_file"],
      ["Edit", "edit_file"],
      ["Glob", "glob"],
      ["Grep", "grep"],
      ["Bash or shell", "exec_command"],
      ["Task or Agent", "spawn_agent"],
    ].flatMap(([vendor, local]) =>
      local !== undefined && names.has(local)
        ? [`Vendor tool ${vendor} corresponds to ${local}.`]
        : [],
    ),
    names.has("read_file")
      ? "read_file supports paginated reads. Continue reading when instruction files are truncated."
      : "",
    names.has("glob")
      ? "glob finds files by path pattern using ripgrep."
      : "",
    names.has("grep")
      ? "grep searches file contents using ripgrep."
      : "",
    names.has("apply_patch")
      ? "Use apply_patch for source patches, following its schema."
      : "",
    names.has("edit_file")
      ? "edit_file replaces matching text. Pass an edits array for changes across files. To create a new file, pass an empty oldString and its contents as newString."
      : "",
    names.has("write_file")
      ? "write_file creates files and can intentionally replace whole files."
      : "",
    names.has("exec_command")
      ? "exec_command can read and search text, run pipelines, invoke git and package managers, and run builds and tests. Choose the available read or search method that fits the task. Follow the current permission policy."
      : "",
    names.has("exec_command")
      ? "exec_command runs shell text, not the JavaScript tool-composition examples in vendor prompts."
      : "",
    names.has("exec_command") && names.has("write_stdin")
      ? "For long-running commands, exec_command returns a session_id when its yield interval expires. Continue independent work, then use write_stdin with that session_id to observe completion. There are no automatic command-completion reminders; use bounded waits without tight polling."
      : "",
    names.has("web_fetch")
      ? "Use web_fetch to read a specific HTTP(S) URL; follow cross-origin redirects with a new call."
      : "",
    names.has("web_search")
      ? "Use web_search for current information; read result pages with available URL-reading tools."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
  const snapshot = { guidance, modelInstructionsRevision }
  return createWorldStateSection({
    id: WorldStateSectionId.Tools,
    snapshot,
    decode: jsonObjectSnapshot,
    render(previous) {
      if (previous.type === "known" && equalJson(previous.snapshot, snapshot))
        return []
      return [
        createWorldStateFragment(
          WorldStateSectionId.Tools,
          "developer",
          `<tool_instructions>\n${guidance}\n</tool_instructions>`,
        ),
      ]
    },
  })
}

function multiAgentSection(
  context: AgentRuntimeContext,
  canSpawnAgent: boolean,
  configuration: ResolvedStepConfiguration,
): WorldStateSection {
  const delegationInstructions = getDelegationInstructions(
    configuration.modelInfo,
    configuration.target.effort,
  )
  const snapshot: JsonObject = {
    path: context.path,
    taskName: context.taskName,
    agentType: context.agentType,
    depth: context.depth,
    maxDepth: context.maxDepth,
    maxConcurrentAgents: context.maxConcurrentAgents,
    canSpawnAgent,
    delegationInstructions,
    modelInstructionsRevision: configuration.modelInstructions.revision,
    ...(context.parentPath === undefined
      ? {}
      : { parentPath: context.parentPath }),
  }
  return createWorldStateSection({
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
          : `Descendants may reach depth ${String(context.maxDepth)}, subject to the current delegation policy.`
      return [
        createWorldStateFragment(
          WorldStateSectionId.MultiAgent,
          "developer",
          `<multi_agent_context>\nYou are agent ${context.path}${context.parentPath === undefined ? "." : `, reporting to ${context.parentPath}.`} ${role}\n${delegationInstructions}\n${delegation}\nThe shared tree allows ${String(context.maxConcurrentAgents)} concurrently running agents including the root. Agents share the workspace: file edits are immediately visible to each other. Assign disjoint write scopes, avoid duplicating delegated work, and review returned changes before integrating them. All agents receive the same tool definitions; follow the role guidance above when choosing actions.\n</multi_agent_context>`,
        ),
      ]
    },
  })
}

export function diffWorldState(
  previous: JsonObject | undefined,
  current: WorldState,
): WorldStateDiff | undefined {
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
  modelOwnedBase: boolean,
): WorldStateSection {
  const modelId = `${configuration.target.provider}/${configuration.target.model}`
  const snapshot = {
    id: modelId,
    instructionsRevision: configuration.modelInstructions.revision,
  }
  return createWorldStateSection({
    id: WorldStateSectionId.Model,
    snapshot,
    decode: jsonObjectSnapshot,
    render(previous) {
      // Discovery can supply a newer model prompt after the Session base was
      // pinned. Record that revision as a developer update, including on the
      // first request, without rewriting the durable base or cache prefix.
      const changed =
        previous.type === "known"
          ? !jsonValuesEqual(previous.snapshot, snapshot)
          : (previousModelId !== undefined && previousModelId !== modelId) ||
            (modelOwnedBase &&
              configuration.baseInstructions.revision !==
                snapshot.instructionsRevision)
      if (!changed || configuration.modelInstructions.text.length === 0)
        return []
      return [
        createWorldStateFragment(
          WorldStateSectionId.Model,
          "developer",
          `<model_switch>\nThe active model or its instructions have changed. Continue the conversation according to the following model-specific instructions.\n\n${configuration.modelInstructions.text}\n</model_switch>`,
        ),
      ]
    },
  })
}

function environmentSection(
  environment: EnvironmentSnapshot,
): WorldStateSection {
  const snapshot = { ...environment }
  const text = renderEnvironmentContext(environment)
  return createWorldStateSection({
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
        createWorldStateFragment(
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

export function createWorldStateFragment(
  id: string,
  role: WorldStateFragment["role"],
  text: string,
): WorldStateFragment {
  return { id, role, text, revision: fingerprint(`${role}\0${text}`) }
}

export function createWorldStateSection<T>(input: {
  readonly id: string
  readonly snapshot: JsonValue
  readonly decode: (value: JsonValue) => T | undefined
  readonly render: (previous: PreviousSectionState<T>) => WorldStateFragment[]
}): WorldStateSection {
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
  if (value === null)
    throw new Error(
      `World-state section ${id} cannot use null as its snapshot.`,
    )
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

function requireUniqueSectionIds(sections: readonly WorldStateSection[]): void {
  const ids = new Set<string>()
  for (const section of sections) {
    if (section.id.trim() === "")
      throw new Error("World-state section ID must not be empty.")
    requireMergePatchSafeSnapshot(section.id, section.snapshot)
    if (ids.has(section.id)) {
      throw new Error(`Duplicate world-state section ID: ${section.id}`)
    }
    ids.add(section.id)
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
