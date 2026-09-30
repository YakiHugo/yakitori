import { parseUserQuestions } from "../../kernel/user-interaction.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool } from "./types.ts"

export function createUserQuestionsTool(): RuntimeTool {
  return {
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
  }
}

function invalid(message: string) {
  return {
    ok: false as const,
    code: "invalid_tool_input",
    message,
    content: message,
  }
}
