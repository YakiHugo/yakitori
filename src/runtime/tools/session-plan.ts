import { parseSessionPlan } from "../../kernel/user-interaction.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool } from "./types.ts"

export function createSessionPlanTool(): RuntimeTool {
  return {
    toolName: plainToolName("update_plan"),
    description:
      "Show an ordered plan and its current progress in the conversation. Send the full plan on each update, with at most one step in progress.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["plan"],
      properties: {
        explanation: {
          type: "string",
          description: "Optional context for this plan update.",
        },
        plan: {
          type: "array",
          description: "Complete list of steps in display order.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["step", "status"],
            properties: {
              step: {
                type: "string",
                minLength: 1,
                description: "A concise description of the step.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Current progress for the step.",
              },
            },
          },
        },
      },
    },
    effect: "observe",
    approvalRequirement: { kind: "none" },
    async execute(input) {
      const plan = parseSessionPlan(input)
      if (plan !== undefined)
        return { ok: true, output: plan, content: "Plan updated." }
      const message = "Provide nonempty steps and at most one step in progress."
      return {
        ok: false,
        code: "invalid_tool_input",
        message,
        content: message,
      }
    },
  }
}
