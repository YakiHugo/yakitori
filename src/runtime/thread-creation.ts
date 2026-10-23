import type { ThreadManager } from "../core/thread-manager.ts"
import { PersistContext, type ThreadStore } from "../core/thread-store.ts"
import { createUserInput } from "../core/user-input.ts"
import {
  isJsonObject,
  isModelSelection,
  type ModelSelection,
} from "../kernel/events.ts"
import { fingerprintOperation } from "../kernel/operation.ts"
import {
  type AgentModelOverrides,
  resolveAgentModelTarget,
} from "./agent-model-selection.ts"
import type { ModelsManager } from "./models-manager.ts"
import { SessionConfiguration } from "./session-configuration.ts"
import { ThreadCollaborationError } from "./thread-collaboration-read.ts"
import { threadMessageSubmissionId } from "./thread-message-identity.ts"

export type ThreadCreateRequest = Readonly<{
  requestId: string
  message: string
  title?: string
  model?: string
  reasoningEffort?: string
}>
export type ThreadCreationContext = Readonly<{
  target: ModelSelection
  readModels(): Promise<AgentModelOverrides>
  models?(provider: string): ModelsManager
  signal?: AbortSignal
}>

// A stable source/request identity owns one visible root, including retries after
// restart. It is deliberately separate from the bounded subagent spawn graph.
export function createThreadCreator(
  input: Readonly<{
    store: ThreadStore
    getThreadManager(): ThreadManager
    onCreated?(threadId: string): void
  }>,
) {
  const pending = new Map<
    string,
    { fingerprint: string; result: Promise<CreatedThread> }
  >()
  return async (
    sourceThreadId: string,
    request: ThreadCreateRequest,
    context?: ThreadCreationContext,
  ): Promise<CreatedThread> => {
    if (!context)
      throw new ThreadCollaborationError(
        "thread_creation_unavailable",
        "Thread creation requires an active source model configuration.",
      )
    if (
      !request.requestId ||
      request.requestId.length > 512 ||
      !request.message.trim() ||
      request.message.length > 65_536 ||
      (request.title !== undefined && !request.title.trim())
    )
      throw new ThreadCollaborationError(
        "invalid_input",
        "Provide a non-empty message of at most 65536 characters, request_id of at most 512 characters and optional non-empty title.",
      )
    const fingerprint = fingerprintOperation({
      message: request.message,
      title: request.title ?? null,
      model: request.model ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
    })
    const digest = fingerprintOperation([
      "thread-creation",
      sourceThreadId,
      request.requestId,
    ]).slice(0, 32)
    const threadId = `session_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`
    const existing = pending.get(threadId)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw conflict()
      return existing.result
    }
    const result = (async (): Promise<CreatedThread> => {
      const manager = input.getThreadManager()
      const source =
        manager.getThread(sourceThreadId) ??
        (await manager.resumeThread(sourceThreadId))
      if (!source)
        throw new ThreadCollaborationError(
          "source_not_found",
          "The source session no longer exists.",
        )
      const parent = source.snapshot()
      const agent = parent.metadata.metadata?.agent
      if (isJsonObject(agent) && agent.kind === "subagent")
        throw new ThreadCollaborationError(
          "source_is_subagent",
          "Create independent tasks from the root session; subagents must use their bounded spawn controller.",
        )
      const stored = await input.store.readThread(threadId)
      let selection: ModelSelection
      if (stored !== undefined) {
        const receipt = stored.metadata.metadata?.threadCreation
        if (
          !isJsonObject(receipt) ||
          receipt.fingerprint !== fingerprint ||
          receipt.sourceThreadId !== sourceThreadId ||
          receipt.requestId !== request.requestId
        )
          throw conflict()
        if (!isModelSelection(receipt.modelSelection))
          throw new Error(
            "Thread creation receipt has invalid model selection.",
          )
        selection = receipt.modelSelection
      } else {
        const catalog = await context.readModels()
        context.signal?.throwIfAborted()
        selection =
          request.model === undefined && request.reasoningEffort === undefined
            ? {
                provider: catalog.current.provider,
                model: catalog.current.model,
                ...(context.target.effort === undefined
                  ? {}
                  : { effort: context.target.effort }),
                ...(context.target.speed === undefined
                  ? {}
                  : { speed: context.target.speed }),
              }
            : resolveAgentModelTarget(context.target, request, catalog)
        const concrete = catalog.resolve(selection)
        const configuration = parent.configuration
        if (configuration === undefined)
          throw new ThreadCollaborationError(
            "source_not_initialized",
            "The source session has no initialized execution policy to inherit.",
          )
        // Inherit session policy explicitly. A new conversation resolves model
        // defaults from its target instead of restoring the source's overrides.
        const initialConfiguration = {
          ...SessionConfiguration.create(
            {
              selection: concrete,
              workspaceRoot: configuration.workspaceRoot,
              promptCacheKey: threadId,
              approvalPolicy: configuration.approvalPolicy,
              executionPolicy: configuration.executionPolicyDefaults,
              enabledTools: configuration.enabledTools,
              ...(configuration.baseInstructions.provenance.type === "custom"
                ? { baseInstructions: configuration.baseInstructions.text }
                : {}),
            },
            context.models?.(concrete.provider),
          ).snapshot,
          modelChoice: selection,
        }
        await manager.createThread({
          threadId,
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(parent.metadata.workingDirectory === undefined
            ? {}
            : { workingDirectory: parent.metadata.workingDirectory }),
          ...(parent.metadata.gitInfo === undefined
            ? {}
            : { gitInfo: parent.metadata.gitInfo }),
          ...(parent.metadata.projectId === undefined
            ? {}
            : { projectId: parent.metadata.projectId }),
          ...(parent.metadata.mateId === undefined
            ? {}
            : { mateId: parent.metadata.mateId }),
          ...(parent.metadata.mateRevisionId === undefined
            ? {}
            : { mateRevisionId: parent.metadata.mateRevisionId }),
          initialConfiguration,
          metadata: {
            threadCreation: {
              sourceThreadId,
              requestId: request.requestId,
              fingerprint,
              modelSelection: { ...selection },
            },
          },
        })
        await input.store.persistThread(threadId, PersistContext.TurnStart)
        await input.store.flushThread(threadId)
        input.onCreated?.(threadId)
      }
      const thread =
        manager.getThread(threadId) ?? (await manager.resumeThread(threadId))
      if (!thread)
        throw new Error("Created thread disappeared before admission.")
      const admitted = await thread.startOrSteer({
        submissionId: threadMessageSubmissionId(
          sourceThreadId,
          threadId,
          request.requestId,
        ),
        content: createUserInput(request.message),
        modelSelection: selection,
        provenance: { sourceThreadId, sourceRequestId: request.requestId },
      })
      if (admitted.type === "not_submitted")
        throw new ThreadCollaborationError(
          admitted.reason,
          "The created session did not admit its task. Retry with the same request_id.",
        )
      return {
        accepted: true,
        threadId,
        turnId: admitted.turnId,
        requestId: request.requestId,
        delivery: admitted.type,
      }
    })()
    pending.set(threadId, { fingerprint, result })
    try {
      return await result
    } finally {
      pending.delete(threadId)
    }
  }
}

type CreatedThread = Readonly<{
  accepted: true
  threadId: string
  turnId: string
  requestId: string
  delivery: "started" | "steered" | "replayed"
}>
function conflict() {
  return new ThreadCollaborationError(
    "request_conflict",
    "This creation request_id already belongs to different content or model settings.",
  )
}
