import { GoalStatus } from "../core/goal.ts"
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../kernel/index.ts"
import { jsonValuesEqual } from "../kernel/json-equality.ts"
import type { ProjectInstructions } from "./project-instructions.ts"
import type { SkillsCatalog } from "./skills.ts"
import {
  createWorldStateSection,
  createWorldStateFragment,
  WorldStateSectionId,
  type WorldStateSection,
} from "./world-state.ts"

type ProjectInstructionsSnapshot = Readonly<{
  directory?: string
  text?: string
}>
type GoalSnapshot = Readonly<{ text?: string; status?: GoalStatus }>

export function createSkillsSection(
  catalog: SkillsCatalog | undefined,
): WorldStateSection {
  const snapshot: JsonObject = {
    skills:
      catalog?.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        scope: skill.scope,
      })) ?? [],
    truncated: catalog?.truncated ?? false,
    text: catalog?.text ?? "",
  }
  return createWorldStateSection({
    id: WorldStateSectionId.Skills,
    snapshot,
    decode: jsonObjectSnapshot,
    render(previous) {
      if (previous.type === "known" && equalJson(previous.snapshot, snapshot)) {
        return []
      }
      if (catalog === undefined) {
        return previous.type === "known" &&
          Array.isArray(previous.snapshot.skills) &&
          previous.snapshot.skills.length > 0
          ? [
              createWorldStateFragment(
                WorldStateSectionId.Skills,
                "developer",
                "<skills_update>No skills are currently available.</skills_update>",
              ),
            ]
          : []
      }
      return [
        createWorldStateFragment(
          WorldStateSectionId.Skills,
          "developer",
          previous.type === "absent"
            ? catalog.text
            : `<skills_update>Replace the previous skills catalog with this catalog.\n\n${catalog.text}\n</skills_update>`,
        ),
      ]
    },
  })
}

export function createProjectInstructionsSection(
  instructions: ProjectInstructions | undefined,
): WorldStateSection {
  const text = instructions?.text
  const snapshot: ProjectInstructionsSnapshot = {
    ...(instructions === undefined
      ? {}
      : { directory: instructions.directory, text: text ?? "" }),
  }
  return createWorldStateSection({
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
          createWorldStateFragment(
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
            createWorldStateFragment(
              WorldStateSectionId.ProjectInstructions,
              "user",
              "<project_instructions_update>\nThe previously supplied project instructions no longer apply.\n</project_instructions_update>",
            ),
          ]
        : []
    },
  })
}

export function createGoalSection(
  goal: string | undefined,
  status: GoalStatus | undefined,
): WorldStateSection {
  const snapshot: GoalSnapshot =
    goal === undefined
      ? {}
      : { text: goal, status: status ?? GoalStatus.Active }
  return createWorldStateSection({
    id: WorldStateSectionId.Goal,
    snapshot: snapshot as JsonObject,
    decode: goalSnapshot,
    render(previous) {
      if (
        previous.type === "known" &&
        equalJson(previous.snapshot as JsonValue, snapshot as JsonValue)
      ) {
        return []
      }
      const previousMayContainGoal =
        previous.type === "unknown" ||
        (previous.type === "known" && previous.snapshot.text !== undefined)
      const previousStatus =
        previous.type === "known" ? previous.snapshot.status : undefined
      // Older snapshots stored only the objective. Treat that as active so a
      // status field added later does not look like a resume.
      if (
        goal !== undefined &&
        previous.type === "known" &&
        previous.snapshot.text === goal &&
        previousStatus === undefined &&
        (snapshot.status === undefined || snapshot.status === GoalStatus.Active)
      ) {
        return []
      }
      if (goal !== undefined) {
        return [
          createWorldStateFragment(
            WorldStateSectionId.Goal,
            "developer",
            goalFragment(
              goal,
              snapshot.status,
              previousMayContainGoal,
              previousStatus,
            ),
          ),
        ]
      }
      return previousMayContainGoal
        ? [
            createWorldStateFragment(
              WorldStateSectionId.Goal,
              "developer",
              "<session_goal_update>\nThe previous session goal has been cleared; it no longer applies.\n</session_goal_update>",
            ),
          ]
        : []
    },
  })
}

function goalFragment(
  goal: string,
  status: GoalStatus | undefined,
  previousMayContainGoal: boolean,
  previousStatus: GoalStatus | undefined,
): string {
  if (status === undefined || status === GoalStatus.Active) {
    if (
      previousMayContainGoal &&
      previousStatus !== undefined &&
      previousStatus !== GoalStatus.Active
    ) {
      return `<session_goal_update>\nThe user resumed this session goal. Keep working toward it across turns until it is met or the user changes it.\n\nGoal: ${goal}\n</session_goal_update>`
    }
    return previousMayContainGoal
      ? `<session_goal_update>\nThis goal replaces the previous session goal. Keep working toward it across turns until it is met or the user changes it.\n\nGoal: ${goal}\n</session_goal_update>`
      : `<session_goal>\nThe user has set a goal for this session. Keep working toward it across turns until it is met or the user changes it.\n\nGoal: ${goal}\n</session_goal>`
  }
  const reason =
    status === GoalStatus.Paused
      ? "The user paused this session goal. Do not keep working toward it until they resume it."
      : status === GoalStatus.Complete
        ? "This session goal is achieved. Do not keep working toward it unless the user sets a new one."
        : status === GoalStatus.Blocked
          ? "This session goal is stalled. Do not keep working toward it until the user resumes it."
          : status === GoalStatus.UsageLimited
            ? "This session goal is usage limited. Do not keep working toward it until the user resumes it."
            : "This session goal has reached its token budget. Do not start further substantive work for it. Wrap up this turn soon: summarize useful progress, remaining work or blockers, and the next step for the user. Only mark complete if all required work is actually finished. A budget limit takes precedence over a requested pause."
  return `<session_goal_update>\n${reason}\n\nGoal: ${goal}\n</session_goal_update>`
}

function projectInstructionsSnapshot(
  value: JsonValue,
): ProjectInstructionsSnapshot | undefined {
  if (!isJsonObject(value)) return undefined
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

function goalSnapshot(value: JsonValue): GoalSnapshot | undefined {
  if (!isJsonObject(value)) return undefined
  if (value.text !== undefined && typeof value.text !== "string")
    return undefined
  if (
    value.status !== undefined &&
    value.status !== GoalStatus.Active &&
    value.status !== GoalStatus.Paused &&
    value.status !== GoalStatus.Blocked &&
    value.status !== GoalStatus.UsageLimited &&
    value.status !== GoalStatus.BudgetLimited &&
    value.status !== GoalStatus.Complete
  ) {
    return undefined
  }
  return {
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.status === undefined
      ? {}
      : { status: value.status as GoalStatus }),
  }
}

function equalJson(left: JsonValue | undefined, right: JsonValue): boolean {
  return left !== undefined && jsonValuesEqual(left, right)
}
function jsonObjectSnapshot(value: JsonValue): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}
