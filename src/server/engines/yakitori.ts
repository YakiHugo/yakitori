import type { SessionEvent } from "../../core/session-io.ts"
import type {
  CreateThreadInput,
  ThreadManager,
} from "../../core/thread-manager.ts"
import type { PermissionGate } from "../../runtime/permission-gate.ts"
import type {
  EngineAdapter,
  EngineBinding,
  EngineCapabilities,
  EngineEvent,
  EngineInput,
  EnginePermissionResponse,
  EngineSendResult,
} from "./engine.ts"

export class YakitoriEngineAdapter implements EngineAdapter {
  readonly id = "yakitori"
  readonly capabilities: EngineCapabilities = {
    resume: true,
    load: true,
    list: true,
    fork: true,
    steer: true,
    queue: true,
    subagents: true,
  }
  readonly #defaults: Pick<CreateThreadInput, "mateId" | "mateRevisionId">
  readonly #manager: ThreadManager
  readonly #resolvePermission: PermissionGate["resolve"] | undefined
  readonly #listeners = new Map<string, Set<(event: EngineEvent) => void>>()
  #closed = false

  constructor(options: {
    manager: ThreadManager
    defaults?: Pick<CreateThreadInput, "mateId" | "mateRevisionId">
    resolvePermission?: PermissionGate["resolve"]
  }) {
    this.#defaults = options.defaults ?? {}
    this.#manager = options.manager
    this.#resolvePermission = options.resolvePermission
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("Yakitori engine is closed.")
  }

  async bind(input: {
    appSessionId: string
    engineSessionId?: string
    cwd: string
  }): Promise<EngineBinding> {
    await this.connect()
    const thread =
      input.engineSessionId === undefined
        ? await this.#manager.createThread({
            ...this.#defaults,
            workingDirectory: input.cwd,
          })
        : await this.#manager.resumeThread(input.engineSessionId)
    if (thread === undefined)
      throw new Error(`Engine session ${input.engineSessionId} was not found.`)
    const cwd = thread.snapshot().metadata.workingDirectory ?? input.cwd
    if (cwd !== input.cwd)
      throw new Error(
        "Engine session working directory does not match its binding.",
      )
    return {
      engineId: this.id,
      appSessionId: input.appSessionId,
      engineSessionId: thread.id,
      cwd,
    }
  }

  async send(
    binding: EngineBinding,
    input: EngineInput,
  ): Promise<EngineSendResult> {
    const thread = await this.#thread(binding)
    const submitted = await thread.startIfIdle({
      submissionId: input.requestId,
      content: input.content ?? {
        kind: "input",
        text: input.text,
        elements: [],
        attachments: [],
      },
      ...(input.modelSelection === undefined
        ? {}
        : { modelSelection: input.modelSelection }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.parentInputId === undefined
        ? {}
        : { parentInputId: input.parentInputId }),
    })
    if (submitted.type === "not_submitted")
      return { status: "rejected", reason: submitted.reason }
    if (submitted.type === "steered")
      throw new Error("Engine start unexpectedly steered a turn.")
    return {
      status: "accepted",
      turnId: submitted.turnId,
      inputId: submitted.inputItemId,
      replayed: submitted.type === "replayed",
    }
  }

  async cancel(
    binding: EngineBinding,
    turnId: string,
    reason?: string,
  ): Promise<{ status: "requested" | "not_running" }> {
    const thread = await this.#thread(binding)
    const requested = await thread.interruptTurn(turnId, reason)
    // This acknowledgement only requests cancellation. The event pump owns the
    // subsequent terminal result, including persistence/cleanup failures.
    return { status: requested ? "requested" : "not_running" }
  }

  async respondPermission(
    binding: EngineBinding,
    response: EnginePermissionResponse,
  ): Promise<boolean> {
    await this.#thread(binding)
    if (
      response.turnId === undefined ||
      (response.optionId !== "allow" && response.optionId !== "deny")
    )
      return false
    return (
      this.#resolvePermission?.({
        sessionId: binding.engineSessionId,
        turnId: response.turnId,
        permissionRequestId: response.requestId,
        behavior: response.optionId,
        ...(response.reason === undefined ? {} : { reason: response.reason }),
      }) ?? false
    )
  }

  subscribe(
    binding: EngineBinding,
    listener: (event: EngineEvent) => void,
  ): () => void {
    this.#validate(binding)
    const listeners = this.#listeners.get(binding.engineSessionId) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(binding.engineSessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(binding.engineSessionId)
    }
  }

  // The native session queue has one consumer. The established rollout pump
  // forwards events here rather than installing a competing event consumer or
  // duplicating native context in an engine journal.
  observe(event: SessionEvent): void {
    let update: EngineEvent | undefined
    if (event.type === "model.stream")
      update = {
        type: "message.delta",
        turnId: event.turnId,
        text: event.delta,
        channel: event.kind,
      }
    else if (event.type === "turn.started")
      update = {
        type: "turn.status",
        turnId: event.input.submissionId,
        status: "running",
      }
    else if (event.type === "turn.completed")
      update = {
        type: "turn.status",
        turnId: event.input.submissionId,
        status: "completed",
      }
    else if (event.type === "turn.failed")
      update = {
        type: "turn.status",
        turnId: event.input.submissionId,
        status: "failed",
        message: event.error.message,
      }
    else if (event.type === "turn.interrupted")
      update = {
        type: "turn.status",
        turnId: event.input.submissionId,
        status: "cancelled",
        ...(event.reason === undefined ? {} : { message: event.reason }),
      }
    else if (
      event.type === "permission" &&
      event.event.type === "permission.requested"
    )
      update = {
        type: "permission.requested",
        turnId: event.event.turnId,
        requestId: event.event.permissionRequestId,
        description: event.event.action,
        options: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Deny" },
        ],
      }
    if (update !== undefined)
      for (const listener of this.#listeners.get(event.threadId) ?? [])
        listener(update)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#listeners.clear()
    // Application composition owns ThreadManager shutdown and its durable fence.
  }

  #validate(binding: EngineBinding): void {
    if (this.#closed) throw new Error("Yakitori engine is closed.")
    if (binding.engineId !== this.id)
      throw new Error("Engine binding belongs to another engine.")
  }

  async #thread(binding: EngineBinding) {
    this.#validate(binding)
    const thread = await this.#manager.resumeThread(binding.engineSessionId)
    if (thread === undefined)
      throw new Error(
        `Engine session ${binding.engineSessionId} was not found.`,
      )
    if (
      (thread.snapshot().metadata.workingDirectory ?? binding.cwd) !==
      binding.cwd
    )
      throw new Error(
        "Engine session working directory does not match its binding.",
      )
    return thread
  }
}
