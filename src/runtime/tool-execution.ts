import type { RolloutAssets } from "../core/rollout-assets.ts"
import { TaskCleanupError } from "../core/session-task.ts"
import type { JsonValue, ToolExecutionItem } from "../kernel/index.ts"
import type { SessionPermissionEvent } from "../protocol/permissions.ts"
import type { BoundAgentControl } from "./agent-control.ts"
import { isAbortError } from "./errors.ts"
import { HookEvent, type HookRunner } from "./hooks.ts"
import type { ModelToolCallBlock } from "./model.ts"
import { toolContentText } from "./model-tool-content.ts"
import type { PermissionGate } from "./permission-gate.ts"
import type { ApprovalPolicy } from "./session-configuration.ts"
import type { BoundThreadCollaboration } from "./thread-collaboration.ts"
import type {
  ToolExecutionGate,
  ToolExecutionReservation,
} from "./tool-execution-gate.ts"
import { resolveToolPermissionRequest } from "./tool-permissions.ts"
import type { ToolRegistry } from "./tools/registry.ts"
import { finalizeToolOutput } from "./tools/result-output.ts"
import type {
  ToolExecutionResult,
  ToolPermissionRequest,
} from "./tools/types.ts"
import {
  grantsFromToolOutput,
  type VisibleFileObservations,
} from "./tools/visible-file-observations.ts"
import { waitForTurnReadiness } from "./turn-readiness.ts"

type ToolExecutionScope = Readonly<{
  documentReading: { nativePdf: boolean; images: boolean }
  threadId: string
  rolloutId: string
  turnId: string
  workspaceRoot: string
  signal: AbortSignal
  toolPlan: ReturnType<ToolRegistry["finalize"]>
  permissionGate: PermissionGate
  recordToolStarted: (item: ToolExecutionItem) => Promise<void>
  publishPermissionEvent: (event: SessionPermissionEvent) => void
  permissionTimeoutMs: number
  approvalPolicy: ApprovalPolicy
  rolloutAssets: RolloutAssets | undefined
  visibleFileObservations: VisibleFileObservations
  toolExecutionGate: ToolExecutionGate
  reportOperationalFailure: (cause: unknown) => void
  agentControl?: BoundAgentControl
  threadCollaboration?: BoundThreadCollaboration
  hookRunner?: HookRunner
}>

type PreparedToolCall = Readonly<{
  call: ModelToolCallBlock
  invocation: Readonly<{
    name: string
    input: JsonValue
  }>
  item: ToolExecutionItem
  permission?: ToolPermissionRequest
  preparationError?: unknown
  hookBlockedReason?: string
  hookContext?: readonly string[]
}>

export async function* executeToolCalls(
  input: ToolExecutionScope &
    Readonly<{
      calls: readonly ModelToolCallBlock[]
      onScheduled?: () => void
    }>,
): AsyncGenerator<
  Readonly<{
    call: ModelToolCallBlock
    item: ToolExecutionItem
    result: ToolExecutionResult
  }>
> {
  const prepared = await Promise.all(
    input.calls.map(async (call): Promise<PreparedToolCall> => {
      let invocation = input.toolPlan.resolveInvocation(call.name, call.input)
      let descriptor = input.toolPlan.describeExecution(
        invocation.name,
        invocation.input,
      )
      try {
        const hookOutcome = await input.hookRunner?.run({
          event: HookEvent.PreToolUse,
          matcher: invocation.name,
          payload: {
            session_id: input.threadId,
            turn_id: input.turnId,
            tool_name: invocation.name,
            tool_use_id: call.id,
            tool_input: invocation.input,
          },
          cwd: input.workspaceRoot,
          signal: input.signal,
        })
        if (hookOutcome?.updatedInput !== undefined) {
          invocation = input.toolPlan.resolveInvocation(
            call.name,
            hookOutcome.updatedInput,
          )
          descriptor = input.toolPlan.describeExecution(
            invocation.name,
            invocation.input,
          )
        }
        const requirement = await input.toolPlan.approvalRequirement(
          invocation.name,
          invocation.input,
          { workspaceRoot: input.workspaceRoot },
        )
        const permission = resolveToolPermissionRequest(
          requirement,
          input.approvalPolicy,
        )
        return {
          call,
          invocation,
          item: {
            itemId: `tool_${globalThis.crypto.randomUUID()}`,
            toolCallId: call.id,
            name: invocation.name,
            input: invocation.input,
            requiresPermission: permission !== undefined,
            ...descriptor,
          },
          ...(permission === undefined ? {} : { permission }),
          ...(hookOutcome?.continue === false
            ? {
                hookBlockedReason:
                  hookOutcome.reason ??
                  "PreToolUse hook blocked the tool call.",
              }
            : {}),
          ...(hookOutcome === undefined ||
          hookOutcome.additionalContext.length === 0
            ? {}
            : { hookContext: hookOutcome.additionalContext }),
        }
      } catch (error) {
        return {
          call,
          invocation,
          item: {
            itemId: `tool_${globalThis.crypto.randomUUID()}`,
            toolCallId: call.id,
            name: invocation.name,
            input: invocation.input,
            requiresPermission: false,
            ...descriptor,
          },
          preparationError: error,
        }
      }
    }),
  )
  for (const item of prepared) await input.recordToolStarted(item.item)
  const scheduled = prepared.map((item) => ({
    item,
    reservation: input.toolExecutionGate.reserve(
      input.toolPlan.supportsParallelToolCalls(item.invocation.name),
      input.signal,
    ),
  }))
  // Like Codex's ordered in-flight drain, commit each available result in call
  // order and drain past cancellation before propagating it to the Turn.
  const inFlight = scheduled.map(({ item, reservation }) =>
    executePreparedTool(input, item, reservation).then(
      (result) => ({
        status: "fulfilled" as const,
        value: { call: item.call, item: item.item, result },
      }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
  )
  input.onScheduled?.()
  let failure: PromiseRejectedResult | undefined
  try {
    for (const pending of inFlight) {
      const outcome = await pending
      if (outcome.status === "fulfilled") yield outcome.value
      else failure ??= outcome
    }
    if (failure !== undefined) throw failure.reason
  } finally {
    // Also drain scheduled work when the consumer exits early.
    await Promise.all(inFlight)
  }
}

export function completeToolExecution(
  toolPlan: ReturnType<ToolRegistry["finalize"]>,
  started: ToolExecutionItem,
  result: ToolExecutionResult,
): ToolExecutionItem {
  if (result.output === undefined) return started
  const descriptor = toolPlan.completeExecution(
    started.name,
    started,
    result.output,
    result.ok,
  )
  if (descriptor.type !== started.type) {
    throw new Error(
      `Tool ${started.name} changed execution type from ${started.type} to ${descriptor.type}.`,
    )
  }
  // The runtime check preserves the discriminated-union member while the
  // registry's provider-neutral return type intentionally erases that link.
  return { ...started, ...descriptor } as ToolExecutionItem
}

async function executePreparedTool(
  input: ToolExecutionScope,
  prepared: PreparedToolCall,
  reservation: ToolExecutionReservation,
): Promise<ToolExecutionResult> {
  try {
    const hookContext = [...(prepared.hookContext ?? [])]
    if (prepared.preparationError !== undefined) {
      throw prepared.preparationError
    }
    if (prepared.hookBlockedReason !== undefined) {
      reservation.cancel()
      return {
        ok: false,
        code: "hook_blocked",
        message: prepared.hookBlockedReason,
        content: `hook_blocked: ${prepared.hookBlockedReason}`,
      }
    }
    if (prepared.permission !== undefined) {
      const permissionHook = await input.hookRunner?.run({
        event: HookEvent.PermissionRequest,
        matcher: prepared.invocation.name,
        payload: {
          session_id: input.threadId,
          turn_id: input.turnId,
          tool_name: prepared.invocation.name,
          tool_use_id: prepared.call.id,
          tool_input: prepared.invocation.input,
          permission_mode: input.approvalPolicy,
        },
        cwd: input.workspaceRoot,
        signal: input.signal,
      })
      hookContext.push(...(permissionHook?.additionalContext ?? []))
      if (permissionHook?.continue === false) {
        reservation.cancel()
        const message =
          permissionHook.reason ?? "PermissionRequest hook denied the tool."
        return {
          ok: false,
          code: "permission_denied",
          message,
          content: message,
        }
      }
      const outcome = await input.permissionGate.request({
        sessionId: input.threadId,
        turnId: input.turnId,
        toolCallId: prepared.call.id,
        action: prepared.permission.action,
        ...(prepared.permission.subject === undefined
          ? {}
          : { subject: prepared.permission.subject }),
        ...(prepared.permission.reason === undefined
          ? {}
          : { reason: prepared.permission.reason }),
        signal: input.signal,
        timeoutMs: input.permissionTimeoutMs,
        publish: input.publishPermissionEvent,
      })
      if (outcome.kind !== "allow") {
        reservation.cancel()
        const message =
          outcome.reason?.message ?? `Tool permission ${outcome.kind}.`
        return {
          ok: false,
          code: `permission_${outcome.kind}`,
          message,
          content: message,
        }
      }
    }
    await waitForTurnReadiness(
      input.toolPlan.waitUntilReady(prepared.invocation.name, {
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
      }),
      input.signal,
    )
    return await reservation.run(async () => {
      const result = await input.toolPlan.execute(
        prepared.invocation.name,
        prepared.invocation.input,
        {
          workspaceRoot: input.workspaceRoot,
          threadId: input.threadId,
          rolloutId: input.rolloutId,
          toolCallId: prepared.call.id,
          turnId: input.turnId,
          signal: input.signal,
          documentReading: input.documentReading,
          ...(input.rolloutAssets === undefined
            ? {}
            : { rolloutAssets: input.rolloutAssets }),
          visibleFileObservations: input.visibleFileObservations,
          ...(input.agentControl === undefined
            ? {}
            : { agentControl: input.agentControl }),
          ...(input.threadCollaboration === undefined
            ? {}
            : { threadCollaboration: input.threadCollaboration }),
        },
      )
      const postHook = await input.hookRunner?.run({
        event: HookEvent.PostToolUse,
        matcher: prepared.invocation.name,
        payload: {
          session_id: input.threadId,
          turn_id: input.turnId,
          tool_name: prepared.invocation.name,
          tool_use_id: prepared.call.id,
          tool_input: prepared.invocation.input,
          tool_response: result.output ?? result.content,
        },
        cwd: input.workspaceRoot,
        signal: input.signal,
      })
      if (postHook?.continue === false) {
        const reason =
          postHook.reason ?? "PostToolUse hook rejected the tool result."
        // Post-execution feedback cannot undo the effect or change its status.
        hookContext.push(
          `PostToolUse check reported a problem after the tool executed: ${reason}`,
        )
      }
      if (input.toolPlan.get(prepared.invocation.name)?.effect !== "observe") {
        const observations = toolFileObservations(result)
        for (const observation of observations) {
          input.visibleFileObservations.apply(observation)
        }
      }
      hookContext.push(...(postHook?.additionalContext ?? []))
      if (hookContext.length === 0) return result
      const contextText = `<hook_context>\n${hookContext.join("\n\n")}\n</hook_context>`
      const projectionContext = {
        workspaceRoot: input.workspaceRoot,
        rolloutId: input.rolloutId,
        toolCallId: prepared.call.id,
        ...(input.rolloutAssets === undefined
          ? {}
          : { rolloutAssets: input.rolloutAssets }),
      }
      return {
        ...result,
        content: `${result.content}\n\n${contextText}`,
        presentation: {
          async toModelContent(budget) {
            // Auxiliary hook text may consume at most half the preview, leaving
            // room for the tool's status and recovery metadata.
            const hook = await finalizeToolOutput(
              { ok: true, content: contextText, output: contextText },
              {
                maxBytes: Math.floor(budget.maxBytes / 2),
                maxLines: Math.floor(budget.maxLines / 2),
              },
              projectionContext,
              "hook-context.txt",
            )
            const body = await finalizeToolOutput(
              result,
              {
                maxBytes:
                  budget.maxBytes -
                  utf8Bytes(toolContentText(hook.content)) -
                  1,
                maxLines:
                  budget.maxLines -
                  toolContentText(hook.content).split("\n").length,
              },
              projectionContext,
            )
            return {
              ...body,
              toolContentBlockCount: body.content.length,
              content: [...body.content, ...hook.content],
            }
          },
        },
      }
    })
  } catch (error) {
    reservation.cancel()
    if (error instanceof TaskCleanupError) throw error
    if (input.signal.aborted || isAbortError(error)) throw abortError()
    input.reportOperationalFailure(error)
    const message = error instanceof Error ? error.message : "Tool failed."
    return {
      ok: false,
      code: "tool_execution_failed",
      message,
      content: `tool_execution_failed: ${message}`,
    }
  }
}

export function toolFileObservations(result: ToolExecutionResult) {
  return result.output === undefined ? [] : grantsFromToolOutput(result.output)
}

function abortError(): Error {
  return new DOMException("Turn aborted.", "AbortError")
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
