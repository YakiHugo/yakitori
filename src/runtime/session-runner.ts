import {
  createYakitoriError,
  PermissionBehavior,
  PermissionState,
  type EventEnvelope,
  type EventMetadata,
  type KernelError,
  type SessionKernel,
  type SessionProjection,
  type TokenUsage,
  type TurnExecutionContext,
  YakitoriErrorCode,
} from "../kernel/index.ts"
import type { MateKernel } from "../mates/index.ts"
import {
  createCoalescingSnapshotPublisher,
  type TransientEventHub,
} from "./live-events.ts"
import { createRuntimeLimits, type RuntimeLimits } from "./limits.ts"
import { buildModelContext } from "./model-context.ts"
import {
  ModelStopReason,
  type ModelContentBlock,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCallBlock,
  type ModelUsage,
  type StreamFn,
} from "./model.ts"
import { createPermissionGate, type PermissionGate } from "./permission-gate.ts"
import { resolveWorkspaceRoot } from "./tools/path-policy.ts"
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts"

export type SessionRunnerOptions = {
  readonly kernel: SessionKernel
  readonly mateKernel: MateKernel
  readonly stream: StreamFn
  readonly durableHub?: {
    publish(events: readonly EventEnvelope[]): void
  }
  readonly transientHub?: TransientEventHub
  readonly toolRegistry?: ToolRegistry
  readonly permissionGate?: PermissionGate
  readonly provider?: string
  readonly model?: string
  readonly limits?: RuntimeLimits
  readonly enabledTools?: readonly string[]
  readonly approvalPolicy?: string
  readonly onRuntimeError?: (error: unknown) => void
}

export type SessionRunner = {
  wake(sessionId: string): Promise<void>
  interrupt(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly reason?: string
  }): Promise<void>
  close(): Promise<void>
}

type LaneState = {
  dirty: boolean
  worker?: Promise<void> | undefined
  abort?: AbortController | undefined
  activeTurnId?: string | undefined
}

export function createSessionRunner(
  options: SessionRunnerOptions,
): SessionRunner {
  const limits = options.limits ?? createRuntimeLimits()
  const provider = options.provider ?? "faux"
  const model = options.model ?? "scripted"
  const toolRegistry = options.toolRegistry ?? createToolRegistry()
  const permissionGate = options.permissionGate ?? createPermissionGate()
  const enabledTools =
    options.enabledTools ?? toolRegistry.tools.map((tool) => tool.name)
  const approvalPolicy = options.approvalPolicy ?? "auto_file_tools"
  const lanes = new Map<string, LaneState>()
  let closed = false

  const publishDurable = (events: readonly EventEnvelope[]) => {
    if (events.length === 0) return
    options.durableHub?.publish(events)
  }

  async function wake(sessionId: string): Promise<void> {
    if (closed) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "SessionRunner is closed.",
      })
    }

    const lane = lanes.get(sessionId) ?? { dirty: false }
    lane.dirty = true
    lanes.set(sessionId, lane)
    ensureWorker(sessionId)

    // Wait until this session is idle (no worker and not dirty).
    for (;;) {
      const current = lanes.get(sessionId)
      if (!current) return
      if (current.worker) {
        await current.worker
        continue
      }
      if (current.dirty) {
        ensureWorker(sessionId)
        continue
      }
      return
    }
  }

  function ensureWorker(sessionId: string): void {
    const lane = lanes.get(sessionId)
    if (!lane || lane.worker || closed) return

    const worker = runLane(sessionId)
      .catch((error) => {
        options.onRuntimeError?.(error)
      })
      .finally(() => {
        const current = lanes.get(sessionId)
        if (current?.worker === worker) current.worker = undefined
        if (current?.dirty && !closed) {
          ensureWorker(sessionId)
          return
        }
        if (current && !current.worker && !current.dirty) {
          lanes.delete(sessionId)
        }
      })
    lane.worker = worker
  }

  async function runLane(sessionId: string): Promise<void> {
    for (;;) {
      if (closed) return
      const lane = lanes.get(sessionId)
      if (!lane) return
      lane.dirty = false

      const read = await options.kernel.readSession({ sessionId })
      const session = read.session
      if (!session) return
      if (session.activeTurn) return

      const nextInput = session.pendingInputs[0]
      if (!nextInput) return

      if (closed) return
      await runTurn(session, nextInput.inputId)
    }
  }

  async function runTurn(
    session: SessionProjection,
    inputId: string,
  ): Promise<void> {
    if (closed) return
    const executionContext = await buildExecutionContext(session)
    if (closed) return
    const started = await options.kernel.startTurn({
      sessionId: session.id,
      inputId,
      executionContext,
    })
    publishDurable(started.events)

    const lane = lanes.get(session.id) ?? { dirty: false }
    const abort = new AbortController()
    lane.abort = abort
    lane.activeTurnId = started.turnId
    lanes.set(session.id, lane)

    if (closed) abort.abort()

    try {
      await executeTextTurn({
        sessionId: session.id,
        turnId: started.turnId,
        inputId,
        executionContext,
        signal: abort.signal,
      })
    } catch (error) {
      await failActiveTurn(session.id, started.turnId, error)
    } finally {
      const current = lanes.get(session.id)
      if (current?.activeTurnId === started.turnId) {
        current.activeTurnId = undefined
        current.abort = undefined
      }
    }
  }

  async function buildExecutionContext(
    session: SessionProjection,
  ): Promise<TurnExecutionContext> {
    if (session.mateId === undefined || session.mateRevisionId === undefined) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Session is missing Mate attribution required for execution.",
        details: { sessionId: session.id },
      })
    }
    if (session.workingDirectory === undefined) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Session is missing workingDirectory required for execution.",
        details: { sessionId: session.id },
      })
    }

    const mate = await options.mateKernel.readMate({ mateId: session.mateId })
    if (!mate.mate) {
      throw createYakitoriError({
        code: YakitoriErrorCode.NotFound,
        message: `Mate ${session.mateId} was not found.`,
        details: { mateId: session.mateId },
      })
    }
    const revision = mate.mate.revisions.find(
      (candidate) => candidate.id === session.mateRevisionId,
    )
    if (!revision) {
      throw createYakitoriError({
        code: YakitoriErrorCode.NotFound,
        message: `Mate revision ${session.mateRevisionId} was not found.`,
        details: {
          mateId: session.mateId,
          mateRevisionId: session.mateRevisionId,
        },
      })
    }

    return {
      mateId: session.mateId,
      mateRevisionId: session.mateRevisionId,
      provider,
      model,
      workingDirectory: session.workingDirectory,
      enabledTools: [...enabledTools],
      approvalPolicy,
      limits: {
        modelCallsPerTurn: limits.modelCallsPerTurn,
        toolCallsPerTurn: limits.toolCallsPerTurn,
        modelVisibleMessageBlocks: limits.modelVisibleMessageBlocks,
        modelVisibleContextBytes: limits.modelVisibleContextBytes,
        modelVisibleToolResultBytes: limits.modelVisibleToolResultBytes,
        modelVisibleToolResultLines: limits.modelVisibleToolResultLines,
        assistantResponseBytes: limits.assistantResponseBytes,
      },
    }
  }

  async function executeTextTurn(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly inputId: string
    readonly executionContext: TurnExecutionContext
    readonly signal: AbortSignal
  }): Promise<void> {
    const mate = await options.mateKernel.readMate({
      mateId: input.executionContext.mateId,
    })
    const revision = mate.mate?.revisions.find(
      (candidate) => candidate.id === input.executionContext.mateRevisionId,
    )
    if (!revision) {
      throw createYakitoriError({
        code: YakitoriErrorCode.NotFound,
        message: `Mate revision ${input.executionContext.mateRevisionId} was not found.`,
      })
    }

    let modelCallIndex = 0
    let toolCallCount = 0
    const usages: ModelUsage[] = []
    while (modelCallIndex < input.executionContext.limits.modelCallsPerTurn) {
      if (input.signal.aborted) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }

      const session = await requireSession(input.sessionId)
      const context = buildModelContext({
        session,
        currentInputId: input.inputId,
        limits: input.executionContext.limits,
      })

      const request: ModelRequest = {
        system: revision.instructions,
        messages: context.messages,
        tools: toolRegistry
          .definitions()
          .filter((tool) =>
            input.executionContext.enabledTools.includes(tool.name),
          ),
        provider: input.executionContext.provider,
        model: input.executionContext.model,
        signal: input.signal,
      }

      const streamId = `stream_${input.turnId}_${modelCallIndex + 1}`
      const response = await consumeModelStream({
        sessionId: input.sessionId,
        turnId: input.turnId,
        streamId,
        request,
      })
      modelCallIndex += 1
      if (response.usage !== undefined) usages.push(response.usage)

      if (
        response.stopReason === ModelStopReason.Aborted ||
        input.signal.aborted
      ) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }

      if (response.stopReason === ModelStopReason.Length) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          "model_length",
          "Model response was truncated by length.",
        )
        return
      }

      if (response.stopReason === ModelStopReason.Error) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          response.error?.code ?? "model_error",
          response.error?.message ?? "Model returned an error.",
        )
        return
      }

      const toolCalls = response.content.filter(
        (block): block is ModelToolCallBlock => block.type === "tool_call",
      )

      if (response.stopReason === ModelStopReason.ToolUse) {
        if (toolCalls.length === 0) {
          await failTurnWithCode(
            input.sessionId,
            input.turnId,
            "provider_protocol_error",
            "tool_use stop reason requires at least one complete tool call.",
          )
          return
        }
        const text = assistantText(response.content)
        if (
          utf8Bytes(text) > input.executionContext.limits.assistantResponseBytes
        ) {
          await failTurnWithCode(
            input.sessionId,
            input.turnId,
            "assistant_output_too_large",
            "Assistant response exceeded the configured byte limit.",
          )
          return
        }
        if (
          toolCallCount + toolCalls.length >
          input.executionContext.limits.toolCallsPerTurn
        ) {
          await failTurnWithCode(
            input.sessionId,
            input.turnId,
            "tool_budget_exhausted",
            `Turn exceeded tool call budget of ${input.executionContext.limits.toolCallsPerTurn}.`,
          )
          return
        }
        toolCallCount += toolCalls.length
        await persistAssistantAndExecuteTools({
          sessionId: input.sessionId,
          turnId: input.turnId,
          text,
          toolCalls,
          streamId,
          modelCallIndex,
          executionContext: input.executionContext,
          contextMetadata: {
            selectedItemIds: [...context.selectedItemIds],
            droppedTurnCount: context.droppedTurnCount,
            truncatedToolResultCount: context.truncatedToolResultCount,
            ...(response.providerRequestId === undefined
              ? {}
              : { providerRequestId: response.providerRequestId }),
          },
          signal: input.signal,
        })
        continue
      }

      if (toolCalls.length > 0) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          "provider_protocol_error",
          "Non-tool_use responses must not include tool calls.",
        )
        return
      }

      const text = assistantText(response.content)
      if (
        utf8Bytes(text) > input.executionContext.limits.assistantResponseBytes
      ) {
        await failTurnWithCode(
          input.sessionId,
          input.turnId,
          "assistant_output_too_large",
          "Assistant response exceeded the configured byte limit.",
        )
        return
      }

      if (text.length === 0) {
        const usage = aggregateTokenUsage(usages)
        const completed = await options.kernel.completeTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          ...(usage === undefined ? {} : { usage }),
        })
        publishDurable([completed.event])
        return
      }

      const usage = aggregateTokenUsage(usages)
      const completed = await options.kernel.completeTurnWithAssistantOutput({
        sessionId: input.sessionId,
        turnId: input.turnId,
        content: { kind: "text", text },
        providerMetadata: {
          provider: input.executionContext.provider,
          model: input.executionContext.model,
          callIndex: modelCallIndex,
          streamId,
          selectedItemIds: [...context.selectedItemIds],
          droppedTurnCount: context.droppedTurnCount,
          truncatedToolResultCount: context.truncatedToolResultCount,
          ...(response.providerRequestId === undefined
            ? {}
            : { providerRequestId: response.providerRequestId }),
        },
        ...(usage === undefined ? {} : { usage }),
      })
      publishDurable(completed.events)
      return
    }

    await failTurnWithCode(
      input.sessionId,
      input.turnId,
      "model_budget_exhausted",
      `Turn exceeded model call budget of ${input.executionContext.limits.modelCallsPerTurn}.`,
    )
  }

  async function persistAssistantAndExecuteTools(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly text: string
    readonly toolCalls: readonly ModelToolCallBlock[]
    readonly streamId: string
    readonly modelCallIndex: number
    readonly executionContext: TurnExecutionContext
    readonly contextMetadata: EventMetadata
    readonly signal: AbortSignal
  }): Promise<void> {
    const recorded = await options.kernel.recordAssistantOutput({
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.text.length === 0
        ? {}
        : { content: [{ type: "text", text: input.text }] }),
      providerMetadata: {
        provider: input.executionContext.provider,
        model: input.executionContext.model,
        callIndex: input.modelCallIndex,
        streamId: input.streamId,
        ...input.contextMetadata,
      },
      toolCalls: input.toolCalls.map((call) => {
        const tool = input.executionContext.enabledTools.includes(call.name)
          ? toolRegistry.get(call.name)
          : undefined
        return {
          id: call.id,
          name: call.name,
          input: call.input,
          requiresPermission: tool !== undefined && !tool.autoAllow,
        }
      }),
    })
    publishDurable(recorded.events)

    const workspaceRoot = await resolveWorkspaceRoot(
      input.executionContext.workingDirectory,
    )

    for (const call of input.toolCalls) {
      if (input.signal.aborted) {
        await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
        return
      }
      const tool = input.executionContext.enabledTools.includes(call.name)
        ? toolRegistry.get(call.name)
        : undefined
      let permissionRequestId: string | undefined
      if (tool !== undefined && !tool.autoAllow) {
        const command =
          typeof call.input === "object" &&
          call.input !== null &&
          "command" in call.input &&
          typeof (call.input as { command: unknown }).command === "string"
            ? (call.input as { command: string }).command
            : call.name
        const permission = await options.kernel.requestPermission({
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolCallId: call.id,
          action: call.name,
          subject: command,
          reason:
            "Command runs with the host user's filesystem, process, environment, and network authority.",
        })
        publishDurable([permission.event])
        permissionRequestId = permission.permissionRequestId
      }

      if (permissionRequestId !== undefined) {
        const allowed = await waitForPermissionAllow({
          sessionId: input.sessionId,
          turnId: input.turnId,
          permissionRequestId,
          signal: input.signal,
        })
        if (!allowed.ok) {
          const denied = await options.kernel.recordToolResult({
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolCallId: call.id,
            error: {
              code: allowed.kind,
              message: allowed.message,
            },
            content: { kind: "text", text: allowed.message },
          })
          publishDurable(denied.events)
          if (allowed.kind === "aborted") {
            await cancelAfterRuntimeAbort(input.sessionId, input.turnId)
            return
          }
          continue
        }
      }

      await options.kernel.requireToolExecutionAllowed({
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: call.id,
      })

      const result =
        tool === undefined
          ? {
              ok: false as const,
              code: "tool_unavailable",
              message: `Tool is not enabled for this Turn: ${call.name}`,
              content: `Tool is not enabled for this Turn: ${call.name}`,
            }
          : await tool.execute(call.input, {
              workspaceRoot,
              signal: input.signal,
            })

      if (result.ok) {
        const resolved = await options.kernel.recordToolResult({
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolCallId: call.id,
          output: result.output,
          content: { kind: "text", text: result.content },
        })
        publishDurable(resolved.events)
        continue
      }

      const resolved = await options.kernel.recordToolResult({
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: call.id,
        error: {
          code: result.code,
          message: result.message,
        },
        content: { kind: "text", text: result.content },
      })
      publishDurable(resolved.events)
    }
  }

  async function waitForPermissionAllow(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
    readonly signal: AbortSignal
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        readonly kind: "permission_denied" | "permission_timeout" | "aborted"
        readonly message: string
      }
  > {
    const deadline = Date.now() + limits.permissionWaitTimeoutMs
    for (;;) {
      const outcome = await readPermissionOutcome(input)
      if (outcome !== undefined) return outcome
      const remaining = deadline - Date.now()
      const wake = await permissionGate.wait({
        sessionId: input.sessionId,
        turnId: input.turnId,
        permissionRequestId: input.permissionRequestId,
        signal: input.signal,
        timeoutMs: remaining,
      })
      if (wake === "aborted") {
        return {
          ok: false,
          kind: "aborted",
          message: "Permission wait aborted. No process was started.",
        }
      }
      if (wake === "timeout") {
        const raced = await readPermissionOutcome(input)
        if (raced !== undefined) return raced
        try {
          const timedOut = await options.kernel.resolvePermission({
            sessionId: input.sessionId,
            turnId: input.turnId,
            permissionRequestId: input.permissionRequestId,
            behavior: PermissionBehavior.Expire,
            reason: {
              kind: "timeout",
              message: "Permission wait timed out.",
            },
          })
          publishDurable([timedOut.event])
        } catch (error) {
          if (!isInvalidState(error)) throw error
          const resolved = await readPermissionOutcome(input)
          if (resolved !== undefined) return resolved
          throw error
        }
        return {
          ok: false,
          kind: "permission_timeout",
          message: "Permission wait timed out. No process was started.",
        }
      }
    }
  }

  async function readPermissionOutcome(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly permissionRequestId: string
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        readonly kind: "permission_denied" | "permission_timeout"
        readonly message: string
      }
    | undefined
  > {
    const session = await requireSession(input.sessionId)
    const permission = session.permissions.find(
      (candidate) =>
        candidate.permissionRequestId === input.permissionRequestId,
    )
    if (!permission) {
      return {
        ok: false,
        kind: "permission_denied",
        message: "Permission request was not found. No process was started.",
      }
    }
    if (permission.state === PermissionState.Pending) return undefined
    if (permission.behavior === PermissionBehavior.Allow) return { ok: true }
    if (permission.behavior === PermissionBehavior.Expire) {
      return {
        ok: false,
        kind: "permission_timeout",
        message:
          permission.decisionReason?.message ??
          "Permission wait timed out. No process was started.",
      }
    }
    return {
      ok: false,
      kind: "permission_denied",
      message:
        permission.decisionReason?.message ??
        "Permission denied. No process was started.",
    }
  }

  async function consumeModelStream(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly streamId: string
    readonly request: ModelRequest
  }): Promise<ModelResponse> {
    const publisher =
      options.transientHub === undefined
        ? undefined
        : createCoalescingSnapshotPublisher(
            options.transientHub,
            limits.assistantSnapshotPublicationsPerSecond,
          )

    let terminal: ModelResponse | undefined
    try {
      for await (const event of options.stream(input.request)) {
        if (event.type === "snapshot") {
          if (utf8Bytes(event.text) > limits.assistantResponseBytes) {
            throw createYakitoriError({
              code: YakitoriErrorCode.InvalidState,
              message: "Assistant snapshot exceeded the configured byte limit.",
              details: { code: "assistant_output_too_large" },
            })
          }
          publisher?.publish({
            sessionId: input.sessionId,
            turnId: input.turnId,
            streamId: input.streamId,
            text: event.text,
          })
          continue
        }

        if (terminal !== undefined) {
          throw createYakitoriError({
            code: YakitoriErrorCode.InvalidState,
            message: "Model stream emitted more than one terminal response.",
            details: { code: "duplicate_terminal_response" },
          })
        }
        terminal = event.response
      }
    } catch (error) {
      publisher?.flush()
      if (isAbortError(error) || input.request.signal?.aborted) {
        return { stopReason: ModelStopReason.Aborted, content: [] }
      }
      throw normalizeStreamError(error)
    }

    publisher?.flush()
    if (terminal === undefined) {
      throw createYakitoriError({
        code: YakitoriErrorCode.InvalidState,
        message: "Model stream ended without a terminal response.",
        details: { code: "premature_stream_end" },
      })
    }
    return terminal
  }

  async function failActiveTurn(
    sessionId: string,
    turnId: string,
    error: unknown,
  ): Promise<void> {
    const read = await options.kernel.readSession({ sessionId })
    const active = read.session?.activeTurn
    if (!active || active.turnId !== turnId) return

    const failed = await options.kernel.failTurn({
      sessionId,
      turnId,
      error: toKernelError(error),
    })
    publishDurable(failed.events)
  }

  async function failTurnWithCode(
    sessionId: string,
    turnId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const failed = await options.kernel.failTurn({
      sessionId,
      turnId,
      error: { code, message },
    })
    publishDurable(failed.events)
  }

  async function cancelActiveTurn(
    sessionId: string,
    turnId: string,
    reason: string,
  ): Promise<void> {
    const read = await options.kernel.readSession({ sessionId })
    const active = read.session?.activeTurn
    if (!active || active.turnId !== turnId) return
    const cancelled = await options.kernel.cancelTurn({
      sessionId,
      turnId,
      reason,
    })
    publishDurable(cancelled.events)
  }

  async function cancelAfterRuntimeAbort(
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    if (closed) return
    await cancelActiveTurn(sessionId, turnId, "aborted")
  }

  async function requireSession(sessionId: string): Promise<SessionProjection> {
    const read = await options.kernel.readSession({ sessionId })
    if (read.session) return read.session
    throw createYakitoriError({
      code: YakitoriErrorCode.NotFound,
      message: `Session ${sessionId} was not found.`,
      details: { sessionId },
    })
  }

  return {
    wake,
    async interrupt(input) {
      const lane = lanes.get(input.sessionId)
      if (!lane || lane.activeTurnId !== input.turnId) {
        // Fall back to durable state: cancel only if the turn is still active.
        const read = await options.kernel.readSession({
          sessionId: input.sessionId,
        })
        const active = read.session?.activeTurn
        if (!active || active.turnId !== input.turnId) {
          throw createYakitoriError({
            code: YakitoriErrorCode.InvalidState,
            message: "Requested turn is not the active runtime turn.",
            details: {
              sessionId: input.sessionId,
              turnId: input.turnId,
              activeTurnId: active?.turnId ?? null,
            },
          })
        }
      }
      lane?.abort?.abort()
      try {
        await cancelActiveTurn(
          input.sessionId,
          input.turnId,
          input.reason ?? "interrupted",
        )
      } catch (error) {
        // Completion may have won the race; that is a valid terminal outcome.
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: unknown }).code === YakitoriErrorCode.InvalidState
        ) {
          return
        }
        throw error
      }
    },
    async close() {
      closed = true
      for (const lane of lanes.values()) lane.abort?.abort()
      await Promise.all(
        Array.from(lanes.values(), (lane) => lane.worker).filter(
          (worker): worker is Promise<void> => worker !== undefined,
        ),
      )
    },
  }
}

function isInvalidState(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === YakitoriErrorCode.InvalidState
  )
}

function aggregateTokenUsage(
  usages: readonly ModelUsage[],
): TokenUsage | undefined {
  if (usages.length === 0) return undefined
  return usages.reduce<TokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  )
}

function assistantText(content: readonly ModelContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
}

function toKernelError(error: unknown): KernelError {
  if (typeof error === "object" && error !== null) {
    const record = error as {
      message?: unknown
      code?: unknown
      details?: unknown
    }
    const message =
      typeof record.message === "string"
        ? record.message
        : "Unexpected runtime error."
    const code =
      typeof record.code === "string"
        ? record.code
        : isEventMetadata(record.details) &&
            typeof record.details.code === "string"
          ? record.details.code
          : "runtime_error"
    return {
      message,
      code,
      ...(isEventMetadata(record.details) ? { details: record.details } : {}),
    }
  }
  return { message: "Unexpected runtime error.", code: "runtime_error" }
}

function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) {
    const details =
      "details" in error && isEventMetadata(error.details)
        ? error.details
        : { code: "model_stream_error" }
    return createYakitoriError({
      code: YakitoriErrorCode.InvalidState,
      message: error.message,
      details,
      cause: error,
    })
  }
  return createYakitoriError({
    code: YakitoriErrorCode.InvalidState,
    message: "Model stream failed.",
    details: { code: "model_stream_error" },
  })
}

function isEventMetadata(value: unknown): value is EventMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((entry) => isJsonValue(entry))
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue)
  }
  return false
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  )
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
