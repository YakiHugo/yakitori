import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

const MAX_DESCRIPTION_CHARACTERS = 1_024
const MAX_PROMPT_CHARACTERS = 65_536

// Subagent kinds, mirroring opencode's primary agents: "general" keeps the
// full tool set (minus task itself), "explore" is read-only.
const AGENTS = ["general", "explore"] as const
type SubagentAgent = (typeof AGENTS)[number]

export function createTaskTool(): RuntimeTool {
  return {
    name: "task",
    description:
      "Delegate a complex, multi-step subtask to a subagent that runs to completion in its own session and context. Do NOT use this to read a specific file or run a precise search — read_file, grep, and glob are faster for that. The prompt must be fully self-contained: the subagent cannot see this conversation, so include all context it needs. The subagent's work and final report are not visible to the user; relay anything that matters in your own response.",
    autoAllow: true,
    effect: "opaque",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          minLength: 1,
          maxLength: MAX_DESCRIPTION_CHARACTERS,
          description: "A short title for the subtask.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PROMPT_CHARACTERS,
          description:
            "The complete, self-contained instructions for the subagent.",
        },
        agent: {
          type: "string",
          enum: [...AGENTS],
          description:
            'The subagent kind: "general" (default) can use all tools; "explore" is read-only (read_file, grep, glob, web_fetch, web_search).',
        },
      },
      required: ["description", "prompt"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseTaskInput(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      if (context.spawnSubagent === undefined) {
        return failure(
          "subagents_unavailable",
          "Subagents are not available in this session.",
        )
      }
      const result = await context.spawnSubagent({
        agent: parsed.agent,
        description: parsed.description,
        prompt: parsed.prompt,
      })
      if (!result.ok) {
        return {
          ok: false,
          code: "subagent_failed",
          message: result.error,
          content:
            result.partialText === undefined
              ? `subagent_failed: ${result.error}`
              : `subagent_failed: ${result.error}\n\nPartial output before the failure:\n${result.partialText}`,
          output: {
            agent: parsed.agent,
            sessionId: result.sessionId,
            error: result.error,
            ...(result.partialText === undefined
              ? {}
              : { partialText: result.partialText }),
          },
        }
      }
      return {
        ok: true,
        output: {
          agent: parsed.agent,
          sessionId: result.sessionId,
          characters: result.text.length,
          content: result.text,
        },
        content: result.text,
      }
    },
  }
}

function parseTaskInput(input: unknown):
  | {
      readonly ok: true
      readonly agent: SubagentAgent
      readonly description: string
      readonly prompt: string
    }
  | { readonly ok: false; readonly message: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "task input must be an object." }
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.description !== "string" ||
    record.description.trim().length === 0 ||
    record.description.length > MAX_DESCRIPTION_CHARACTERS
  ) {
    return {
      ok: false,
      message: `task description must be 1-${String(MAX_DESCRIPTION_CHARACTERS)} characters.`,
    }
  }
  if (
    typeof record.prompt !== "string" ||
    record.prompt.trim().length === 0 ||
    record.prompt.length > MAX_PROMPT_CHARACTERS
  ) {
    return {
      ok: false,
      message: `task prompt must be 1-${String(MAX_PROMPT_CHARACTERS)} characters.`,
    }
  }
  if (
    record.agent !== undefined &&
    !AGENTS.includes(record.agent as SubagentAgent)
  ) {
    return {
      ok: false,
      message: `task agent must be one of: ${AGENTS.join(", ")}.`,
    }
  }
  return {
    ok: true,
    agent: (record.agent as SubagentAgent | undefined) ?? "general",
    description: record.description,
    prompt: record.prompt,
  }
}

function failure(code: string, message: string): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: `${code}: ${message}`,
  }
}
