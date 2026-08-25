import {
  AgentControlError,
  type AgentStatus,
  type AgentType,
  type BoundAgentControl,
  type ForkTurns,
} from "../agent-control.ts"
import type { JsonObject, JsonValue } from "../../kernel/index.ts"
import {
  collaborationExecution,
  completeCollaborationExecution,
} from "./execution-descriptors.ts"
import { noToolApprovalRequired } from "./approval-requirements.ts"
import type { RuntimeTool, ToolExecutionResult } from "./types.ts"

const MAX_MESSAGE_CHARACTERS = 65_536
const MAX_TASK_NAME_CHARACTERS = 64
const MAX_WAIT_MS = 300_000
const AGENT_TYPES = ["general", "explore"] as const

export function createMultiAgentTools(): readonly RuntimeTool[] {
  return [
    createSpawnAgentTool(),
    createSendMessageTool(),
    createFollowupTaskTool(),
    createWaitAgentTool(),
    createInterruptAgentTool(),
    createListAgentsTool(),
  ]
}

function createSpawnAgentTool(): RuntimeTool {
  return {
    name: "spawn_agent",
    description:
      "Spawn an agent for a concrete, bounded subtask that can run independently alongside useful local work. The child inherits the current model and tools, can spawn descendants within the configured depth limit, and returns immediately with an agent id and canonical task path. It starts with a fresh conversation context by default and receives message as its assigned task. Set fork_turns to all or a positive integer string only when the child genuinely needs parent history.",
    approvalRequirement: noToolApprovalRequired,
    // Multiple spawn calls in one model response are intentionally safe to
    // execute together; they do not mutate the workspace themselves.
    effect: "observe",
    describeExecution: collaborationExecution("spawn"),
    completeExecution: completeCollaborationExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_name: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TASK_NAME_CHARACTERS,
          pattern: "^[a-z0-9_]+$",
          description:
            "Task name for the new agent, using lowercase letters, digits, and underscores.",
        },
        message: messageSchema("Initial plain-text task for the new agent."),
        agent_type: {
          type: "string",
          enum: [...AGENT_TYPES],
          description:
            "Optional agent role. General is the default; explore is instructed to inspect without modifying files.",
        },
        fork_turns: {
          type: "string",
          default: "none",
          description:
            'Optional parent history to inherit: "none" (default), "all", or a positive integer string such as "3".',
        },
        model: {
          type: "string",
          minLength: 1,
          description:
            "Optional model override within the current provider. Omit unless explicitly needed.",
        },
        reasoning_effort: {
          type: "string",
          minLength: 1,
          description: "Optional reasoning effort override for the child.",
        },
      },
      required: ["task_name", "message"],
    },
    async execute(input, context) {
      const control = requireControl(context.agentControl)
      if (!control.ok) return control.error
      const parsed = parseSpawnInput(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      return runControl(async () => {
        const spawned = await control.value.spawn(parsed.value)
        return success(spawned, JSON.stringify(spawned))
      })
    },
  }
}

function createSendMessageTool(): RuntimeTool {
  return {
    name: "send_message",
    description:
      "Send a message to an existing agent. The message is delivered at the next model sampling boundary and does not start a new turn.",
    approvalRequirement: noToolApprovalRequired,
    effect: "opaque",
    describeExecution: collaborationExecution("send_message"),
    completeExecution: completeCollaborationExecution,
    inputSchema: targetMessageSchema(
      "Relative task name, canonical task path, or agent id.",
    ),
    async execute(input, context) {
      const control = requireControl(context.agentControl)
      if (!control.ok) return control.error
      const parsed = parseTargetMessage(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      return runControl(async () => {
        const receiver = await control.value.sendMessage(parsed.value)
        return success(
          { delivered: true, ...receiver },
          "Message queued for delivery.",
        )
      })
    },
  }
}

function createFollowupTaskTool(): RuntimeTool {
  return {
    name: "followup_task",
    description:
      "Send a follow-up task to a non-root agent. If it is idle, this starts a new turn; if it is running, the task is queued for the next turn boundary.",
    approvalRequirement: noToolApprovalRequired,
    effect: "opaque",
    describeExecution: collaborationExecution("follow_up"),
    completeExecution: completeCollaborationExecution,
    inputSchema: targetMessageSchema(
      "Relative task name, canonical task path, or agent id.",
    ),
    async execute(input, context) {
      const control = requireControl(context.agentControl)
      if (!control.ok) return control.error
      const parsed = parseTargetMessage(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      return runControl(async () => {
        const receiver = await control.value.followup(parsed.value)
        return success(
          { accepted: true, ...receiver },
          "Follow-up task accepted.",
        )
      })
    },
  }
}

function createWaitAgentTool(): RuntimeTool {
  return {
    name: "wait_agent",
    description:
      "Wait for a mailbox or final-status update from any agent in the current tree. Returns immediately when an update is already queued, or after the timeout with an empty update list.",
    approvalRequirement: noToolApprovalRequired,
    effect: "opaque",
    describeExecution: collaborationExecution("wait"),
    completeExecution: completeCollaborationExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        timeout_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_WAIT_MS,
          description: "Maximum wait in milliseconds. Defaults to 30000.",
        },
      },
    },
    async execute(input, context) {
      const control = requireControl(context.agentControl)
      if (!control.ok) return control.error
      const parsed = parseWaitInput(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      return runControl(async () => {
        const updates = await control.value.wait(parsed.timeoutMs)
        const output = { timedOut: updates.length === 0, updates }
        return success(output, JSON.stringify(output))
      })
    },
  }
}

function createInterruptAgentTool(): RuntimeTool {
  return {
    name: "interrupt_agent",
    description:
      "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
    approvalRequirement: noToolApprovalRequired,
    effect: "opaque",
    describeExecution: collaborationExecution("interrupt"),
    completeExecution: completeCollaborationExecution,
    inputSchema: targetSchema(),
    async execute(input, context) {
      const control = requireControl(context.agentControl)
      if (!control.ok) return control.error
      const parsed = parseTarget(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      return runControl(async () => {
        const interrupted = await control.value.interrupt(parsed.target)
        return success(
          {
            ...interrupted,
            previousStatus: statusValue(interrupted.previousStatus),
          },
          JSON.stringify({ previousStatus: interrupted.previousStatus }),
        )
      })
    },
  }
}

function createListAgentsTool(): RuntimeTool {
  return {
    name: "list_agents",
    description:
      "List agents in the current root tree, optionally filtered by a canonical task-path prefix.",
    approvalRequirement: noToolApprovalRequired,
    effect: "observe",
    describeExecution: collaborationExecution("list"),
    completeExecution: completeCollaborationExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path_prefix: {
          type: "string",
          minLength: 1,
          description: "Canonical task-path prefix without a trailing slash.",
        },
      },
    },
    async execute(input, context) {
      const control = requireControl(context.agentControl)
      if (!control.ok) return control.error
      const parsed = parseListInput(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      const agents = control.value.list(parsed.pathPrefix)
      return success({ agents }, JSON.stringify({ agents }))
    },
  }
}

function messageSchema(description: string): JsonObject {
  return {
    type: "string",
    minLength: 1,
    maxLength: MAX_MESSAGE_CHARACTERS,
    description,
  }
}

function targetSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      target: {
        type: "string",
        minLength: 1,
        description: "Relative task name, canonical task path, or agent id.",
      },
    },
    required: ["target"],
  }
}

function targetMessageSchema(targetDescription: string): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      target: {
        type: "string",
        minLength: 1,
        description: targetDescription,
      },
      message: messageSchema("Message text."),
    },
    required: ["target", "message"],
  }
}

function parseSpawnInput(input: unknown):
  | {
      readonly ok: true
      readonly value: {
        readonly taskName: string
        readonly message: string
        readonly agentType: AgentType
        readonly forkTurns: ForkTurns
        readonly model?: string
        readonly reasoningEffort?: string
      }
    }
  | { readonly ok: false; readonly message: string } {
  const record = recordInput(input)
  if (record === undefined)
    return invalid("spawn_agent input must be an object.")
  const taskName = nonEmptyString(record.task_name, MAX_TASK_NAME_CHARACTERS)
  if (taskName === undefined || !/^[a-z0-9_]+$/.test(taskName)) {
    return invalid(
      "task_name must use 1-64 lowercase letters, digits, or underscores.",
    )
  }
  const message = nonEmptyString(record.message, MAX_MESSAGE_CHARACTERS)
  if (message === undefined) return invalid("message must be non-empty.")
  if (
    record.agent_type !== undefined &&
    !AGENT_TYPES.includes(record.agent_type as AgentType)
  ) {
    return invalid(`agent_type must be one of: ${AGENT_TYPES.join(", ")}.`)
  }
  const forkTurns = parseForkTurns(record.fork_turns)
  if (forkTurns === undefined) {
    return invalid(
      'fork_turns must be "none", "all", or a positive integer string.',
    )
  }
  const model = optionalNonEmptyString(record.model)
  const reasoningEffort = optionalNonEmptyString(record.reasoning_effort)
  if (model === false || reasoningEffort === false) {
    return invalid("model and reasoning_effort must be non-empty strings.")
  }
  return {
    ok: true,
    value: {
      taskName,
      message,
      agentType: (record.agent_type as AgentType | undefined) ?? "general",
      forkTurns,
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  }
}

function parseTargetMessage(input: unknown):
  | {
      readonly ok: true
      readonly value: { readonly target: string; readonly message: string }
    }
  | { readonly ok: false; readonly message: string } {
  const record = recordInput(input)
  if (record === undefined) return invalid("tool input must be an object.")
  const target = nonEmptyString(record.target, 1_024)
  const message = nonEmptyString(record.message, MAX_MESSAGE_CHARACTERS)
  if (target === undefined || message === undefined) {
    return invalid("target and message must be non-empty strings.")
  }
  return { ok: true, value: { target, message } }
}

function parseTarget(
  input: unknown,
):
  | { readonly ok: true; readonly target: string }
  | { readonly ok: false; readonly message: string } {
  const record = recordInput(input)
  const target = record && nonEmptyString(record.target, 1_024)
  return target === undefined
    ? invalid("target must be a non-empty string.")
    : { ok: true, target }
}

function parseWaitInput(
  input: unknown,
):
  | { readonly ok: true; readonly timeoutMs: number }
  | { readonly ok: false; readonly message: string } {
  const record = recordInput(input)
  if (record === undefined)
    return invalid("wait_agent input must be an object.")
  if (record.timeout_ms === undefined) return { ok: true, timeoutMs: 30_000 }
  if (
    typeof record.timeout_ms !== "number" ||
    !Number.isInteger(record.timeout_ms) ||
    record.timeout_ms < 0 ||
    record.timeout_ms > MAX_WAIT_MS
  ) {
    return invalid(
      `timeout_ms must be an integer from 0-${String(MAX_WAIT_MS)}.`,
    )
  }
  return { ok: true, timeoutMs: record.timeout_ms }
}

function parseListInput(
  input: unknown,
):
  | { readonly ok: true; readonly pathPrefix?: string }
  | { readonly ok: false; readonly message: string } {
  const record = recordInput(input)
  if (record === undefined)
    return invalid("list_agents input must be an object.")
  if (record.path_prefix === undefined) return { ok: true }
  const pathPrefix = nonEmptyString(record.path_prefix, 1_024)
  if (pathPrefix === undefined || pathPrefix.endsWith("/")) {
    return invalid(
      "path_prefix must be a non-empty path without a trailing slash.",
    )
  }
  return { ok: true, pathPrefix }
}

function parseForkTurns(value: unknown): ForkTurns | undefined {
  if (value === undefined || value === "none") return "none"
  if (value === "all") return "all"
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    return undefined
  }
  return Number(value)
}

function recordInput(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}

function nonEmptyString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && value.length <= max ? value : undefined
}

function optionalNonEmptyString(value: unknown): string | undefined | false {
  if (value === undefined) return undefined
  return typeof value === "string" && value.trim().length > 0 ? value : false
}

function invalid(message: string): {
  readonly ok: false
  readonly message: string
} {
  return { ok: false, message }
}

function requireControl(
  control: BoundAgentControl | undefined,
):
  | { readonly ok: true; readonly value: BoundAgentControl }
  | { readonly ok: false; readonly error: ToolExecutionResult } {
  return control === undefined
    ? {
        ok: false,
        error: failure(
          "agents_unavailable",
          "Multi-agent control is unavailable in this session.",
        ),
      }
    : { ok: true, value: control }
}

async function runControl(
  run: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof AgentControlError) {
      return failure(error.code, error.message)
    }
    throw error
  }
}

function success(output: JsonValue, content: string): ToolExecutionResult {
  return { ok: true, output, content }
}

function failure(code: string, message: string): ToolExecutionResult {
  return { ok: false, code, message, content: `${code}: ${message}` }
}

function statusValue(status: AgentStatus): JsonValue {
  return status as JsonValue
}
