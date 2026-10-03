import type { ThreadGoal } from "../../core/goal.ts"
import { noToolApprovalRequired } from "./approval-requirements.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

export type GoalToolService = Readonly<{
  get(threadId: string): Promise<ThreadGoal | undefined>
  create(
    threadId: string,
    input: Readonly<{ objective: string; tokenBudget?: number }>,
    turnId?: string,
  ): Promise<ThreadGoal>
  update(
    threadId: string,
    status: "complete" | "blocked" | "paused",
    turnId?: string,
  ): Promise<ThreadGoal>
}>

export class GoalToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "GoalToolError"
  }
}

export function createGoalTools(service: GoalToolService): RuntimeTool[] {
  return [
    {
      toolName: plainToolName("get_goal"),
      description:
        "Read this thread's goal, status, token budget, consumed tokens, elapsed work time, and remaining tokens.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
      effect: "observe",
      approvalRequirement: noToolApprovalRequired,
      async execute(input, context) {
        if (!isRecord(input) || Object.keys(input).length !== 0)
          return failure(
            "invalid_tool_input",
            "get_goal expects an empty object.",
          )
        const threadId = context.threadId
        if (!threadId)
          return failure(
            "goal_unavailable",
            "Goal tools require a persistent thread.",
          )
        return runGoal(() => service.get(threadId))
      },
    },
    {
      toolName: plainToolName("create_goal"),
      description:
        "Start an active goal only when the user or system/developer instructions explicitly request one; an ordinary task is not a request to create a goal. Include token_budget only if explicitly requested. An unfinished goal cannot be replaced; a completed goal can be replaced.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: {
          objective: {
            type: "string",
            minLength: 1,
            description: "The concrete objective to pursue.",
          },
          token_budget: {
            type: "integer",
            minimum: 1,
            description:
              "Explicitly requested positive token budget; otherwise omit.",
          },
        },
      },
      effect: "mutate",
      approvalRequirement: noToolApprovalRequired,
      async execute(input, context) {
        if (
          !isRecord(input) ||
          Object.keys(input).some(
            (key) => key !== "objective" && key !== "token_budget",
          ) ||
          typeof input.objective !== "string" ||
          input.objective.trim().length === 0
        )
          return failure(
            "invalid_tool_input",
            "Provide a nonempty objective and an optional token_budget only.",
          )
        const tokenBudget = input.token_budget
        if (
          tokenBudget !== undefined &&
          (typeof tokenBudget !== "number" ||
            !Number.isSafeInteger(tokenBudget) ||
            tokenBudget <= 0)
        )
          return failure(
            "invalid_tool_input",
            "token_budget must be a positive safe integer.",
          )
        const threadId = context.threadId
        if (!threadId)
          return failure(
            "goal_unavailable",
            "Goal tools require a persistent thread.",
          )
        const objective = input.objective.trim()
        return runGoal(() =>
          service.create(
            threadId,
            {
              objective,
              ...(tokenBudget === undefined ? {} : { tokenBudget }),
            },
            context.turnId,
          ),
        )
      },
    },
    {
      toolName: plainToolName("update_goal"),
      description:
        "Change the existing goal's status. Use complete only after current evidence establishes that every requirement is finished, never merely because work is stopping or the budget is low. Use paused only after an explicit user request; a later resume cancels that request. Report the returned status and stop goal work; budget limits take precedence. Use blocked only when the same blocker has persisted for at least three consecutive goal turns, including user and automatic turns, and further progress requires user input or an external change. A resumed blocked goal starts a fresh three-turn audit. Once that threshold is met, record blocked instead of repeatedly reporting it while active. Difficulty, uncertainty, slow progress, or optional clarification alone are not blockers. This tool cannot resume a goal or change its objective, budget, or system limits. After completing a budgeted goal, report the final token usage returned here.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["complete", "blocked", "paused"] },
        },
      },
      effect: "mutate",
      approvalRequirement: noToolApprovalRequired,
      async execute(input, context) {
        if (
          !isRecord(input) ||
          Object.keys(input).some((key) => key !== "status") ||
          (input.status !== "complete" &&
            input.status !== "blocked" &&
            input.status !== "paused")
        )
          return failure(
            "invalid_tool_input",
            "status must be complete, blocked, or paused; no other fields are accepted.",
          )
        const threadId = context.threadId
        if (!threadId)
          return failure(
            "goal_unavailable",
            "Goal tools require a persistent thread.",
          )
        const status = input.status
        return runGoal(
          () => service.update(threadId, status, context.turnId),
          true,
        )
      },
    },
  ]
}

async function runGoal(
  operation: () => Promise<ThreadGoal | undefined>,
  reportCompletion = false,
): Promise<ToolExecutionResult> {
  try {
    const goal = await operation()
    const tokenBudget = goal?.tokenBudget
    const output = {
      goal: goal ?? null,
      remainingTokens:
        goal === undefined || tokenBudget === undefined
          ? null
          : Math.max(0, tokenBudget - goal.tokensUsed),
      completionBudgetReport:
        reportCompletion &&
        goal?.status === "complete" &&
        tokenBudget !== undefined
          ? `Goal completed using ${goal.tokensUsed} of ${tokenBudget} budgeted tokens.`
          : null,
    }
    return { ok: true, output, content: JSON.stringify(output) }
  } catch (error) {
    if (error instanceof GoalToolError)
      return failure(error.code, error.message)
    throw error
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function failure(code: string, message: string): ToolExecutionResult {
  return { ok: false, code, message, content: message }
}
