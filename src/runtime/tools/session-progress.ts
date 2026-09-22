import {
  parseSessionPlan,
  parseUserQuestions,
} from "../../kernel/user-interaction.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool } from "./types.ts"

export function createSessionProgressTools(): readonly RuntimeTool[] {
  return [
    {
      toolName: plainToolName("request_user_input_async"),
      description:
        "Ask the user one or more questions without blocking independent work. Answers arrive as user input linked to this request. Use options for suggested answers (recommended first), or omit options for free text. Do not proceed with work that requires an unanswered decision or approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["questions"],
        properties: {
          questions: {
            type: "array",
            description:
              "Self-contained questions to present together, in display order.",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title"],
              properties: {
                title: {
                  type: "string",
                  minLength: 1,
                  description:
                    "The complete question, including enough context to answer.",
                },
                options: {
                  type: "array",
                  description:
                    "Suggested answers, recommended first. Free-text answers are always available.",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
      },
      effect: "observe",
      supportsParallelToolCalls: true,
      approvalRequirement: { kind: "none" },
      async execute(input) {
        const questions = parseUserQuestions(input)
        if (questions === undefined)
          return invalid("Provide nonempty questions and nonempty options.")
        // The normal tool-result persistence barrier owns the question. The
        // host admits answers as correlated user inputs, following Codex's
        // async question delivery without a second mutable question database.
        return {
          ok: true,
          output: questions,
          content:
            "Questions presented to the user. Continue independent work; answers will arrive as user input.",
        }
      },
    },
    {
      toolName: plainToolName("update_plan"),
      description:
        "Update the task's progress checklist. Provide the complete current plan, with at most one step in_progress. Use explanation when the plan changes. This records progress; it does not request approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["plan"],
        properties: {
          explanation: {
            type: "string",
            description: "Optional explanation of a plan change.",
          },
          plan: {
            type: "array",
            description:
              "The complete ordered checklist. At most one step may be in_progress.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["step", "status"],
              properties: {
                step: {
                  type: "string",
                  minLength: 1,
                  description: "A concrete task or outcome.",
                },
                status: {
                  type: "string",
                  description: "The current progress of this step.",
                  enum: ["pending", "in_progress", "completed"],
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
        if (plan === undefined)
          return invalid(
            "Provide valid plan steps with at most one step in_progress.",
          )
        return { ok: true, output: plan, content: "Plan updated." }
      },
    },
  ]
}

function invalid(message: string) {
  return {
    ok: false as const,
    code: "invalid_tool_input",
    message,
    content: message,
  }
}
