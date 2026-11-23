import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import type {
  EngineAdapter,
  EngineBinding,
  EngineCapabilities,
  EngineEvent,
  EngineInput,
  EnginePermissionResponse,
  EngineSendResult,
} from "../engine.ts"
import {
  type AcpCommand,
  AcpRpcError,
  AcpStdioConnection,
  object,
} from "./stdio.ts"

type Permission = {
  options: Set<string>
  resolve: (outcome: unknown) => void
}
type Session = {
  binding: EngineBinding
  listeners: Set<(event: EngineEvent) => void>
  backlog: EngineEvent[]
  requests: Map<string, EngineSendResult>
  permissions: Map<string, Permission>
  active?: { turnId: string; cancelling: boolean }
  connected: boolean
  loading?: boolean
  controls: readonly AcpConfigControl[]
  configuring?: boolean
  preparingPrompt?: boolean
}

export type AcpEngineOptions = AcpCommand & {
  id: string
  onStderr?: (text: string) => void
  initializeTimeoutMs?: number
  readAttachment?: (source: AssetSource) => Promise<Buffer>
}

/** Full-agent ACP v1 boundary; never used as a ModelProvider. */
export function createAcpEngine(options: AcpEngineOptions): AcpEngine {
  return new AcpEngine(options)
}

export class AcpEngine implements EngineAdapter {
  readonly id: string
  private connection: AcpStdioConnection | undefined
  private connecting: Promise<void> | undefined
  private closing = new Set<Promise<void>>()
  private closed = false
  private sessions = new Map<string, Session>()
  private bindingRequests = new Map<string, Promise<EngineBinding>>()
  private openingSessions = 0
  private startupUpdates: {
    sessionId: string
    update: Record<string, unknown>
  }[] = []
  private negotiated: EngineCapabilities = {
    resume: false,
    load: false,
    list: false,
    fork: false,
    steer: false,
    queue: false,
    subagents: false,
  }

  private options: AcpEngineOptions
  constructor(options: AcpEngineOptions) {
    this.options = options
    this.id = options.id
  }
  get capabilities(): EngineCapabilities {
    return this.negotiated
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("ACP engine is closed"))
    if (this.connecting) return this.connecting
    if (this.connection) return Promise.resolve()
    const connection = new AcpStdioConnection(this.options, {
      notification: (method, params) => this.notification(method, params),
      request: (method, params) => this.request(method, params),
      disconnected: (error) => {
        if (this.connection !== connection) return
        this.connection = undefined
        const closing = connection.close()
        this.closing.add(closing)
        void closing.finally(() => this.closing.delete(closing))
        for (const session of this.sessions.values()) {
          session.connected = false
          this.cancelPermissions(session)
          if (session.active) {
            this.emit(session, {
              type: "turn.status",
              turnId: session.active.turnId,
              status: "disconnected",
              message: error.message,
            })
            delete session.active
          }
        }
      },
      ...(this.options.onStderr ? { stderr: this.options.onStderr } : {}),
    })
    this.connection = connection
    const timeout = setTimeout(
      () => connection.close(new Error("ACP initialization timed out")),
      this.options.initializeTimeoutMs ?? 15_000,
    )
    this.connecting = connection
      .request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "yakitori", version: "0.0.0" },
        // File/terminal callbacks are deliberately not advertised: the external
        // agent owns its execution environment and no client sandbox is bypassed.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })
      .then((value) => {
        const result = object(value)
        if (result.protocolVersion !== 1)
          throw new Error("External agent does not support ACP v1")
        const capabilities = object(result.agentCapabilities ?? {})
        const sessions = object(capabilities.sessionCapabilities ?? {})
        const prompt = object(capabilities.promptCapabilities ?? {})
        const promptCapabilities: EnginePromptCapabilities = {
          ...(prompt.image === true ? { image: true } : {}),
          ...(prompt.embeddedContext === true ? { embeddedContext: true } : {}),
        }
        this.negotiated = {
          ...this.negotiated,
          load: capabilities.loadSession === true,
          resume: sessions.resume != null,
          list: sessions.list != null,
          ...(Object.keys(promptCapabilities).length === 0
            ? {}
            : { prompt: promptCapabilities }),
        }
      })
      .catch((error: unknown) => {
        connection.close()
        throw error
      })
      .finally(() => {
        clearTimeout(timeout)
        this.connecting = undefined
      })
    return this.connecting
  }

  bind(input: {
    appSessionId: string
    engineSessionId?: string
    cwd: string
  }): Promise<EngineBinding> {
    const pending = this.bindingRequests.get(input.appSessionId)
    if (pending) return pending.then(() => this.bind(input))
    const binding = this.bindSession(input).finally(() =>
      this.bindingRequests.delete(input.appSessionId),
    )
    this.bindingRequests.set(input.appSessionId, binding)
    return binding
  }

  private async bindSession(input: {
    appSessionId: string
    engineSessionId?: string
    cwd: string
  }): Promise<EngineBinding> {
    if (!isAbsolute(input.cwd))
      throw new Error("ACP session cwd must be absolute")
    await this.connect()
    if (this.closed) throw new Error("ACP engine is closed")
    const old = this.sessions.get(input.appSessionId)
    if (old?.connected) {
      if (
        old.binding.cwd !== input.cwd ||
        (input.engineSessionId &&
          old.binding.engineSessionId !== input.engineSessionId)
      ) {
        throw new Error("Cannot rebind an active ACP session")
      }
      return old.binding
    }
    const engineSessionId =
      input.engineSessionId ?? old?.binding.engineSessionId
    if (
      engineSessionId &&
      [...this.sessions.values()].some(
        (session) =>
          session.binding.appSessionId !== input.appSessionId &&
          session.binding.engineSessionId === engineSessionId,
      )
    ) {
      throw new Error("ACP session is already bound to another app session")
    }
    const session: Session = old ?? {
      binding: {
        engineId: this.id,
        appSessionId: input.appSessionId,
        engineSessionId: engineSessionId ?? "",
        cwd: input.cwd,
      },
      listeners: new Set(),
      backlog: [],
      requests: new Map(),
      permissions: new Map(),
      connected: false,
      controls: [],
    }
    if (
      old &&
      (old.binding.cwd !== input.cwd ||
        old.binding.engineSessionId !== engineSessionId)
    ) {
      throw new Error("ACP reconnect must retain the session binding")
    }
    this.sessions.set(input.appSessionId, session)
    const params = { cwd: input.cwd, mcpServers: [] }
    let result: Record<string, unknown>
    if (engineSessionId) {
      const method = this.capabilities.resume
        ? "session/resume"
        : this.capabilities.load
          ? "session/load"
          : undefined
      if (!method)
        throw new Error(
          "External agent cannot reconnect: no session resume/load capability",
        )
      session.loading = method === "session/load"
      try {
        result = object(
          await this.requireConnection().request(method, {
            ...params,
            sessionId: engineSessionId,
          }),
        )
      } finally {
        delete session.loading
      }
    } else {
      this.openingSessions++
      try {
        result = object(
          await this.requireConnection().request("session/new", params),
        )
      } finally {
        this.openingSessions--
      }
      if (typeof result.sessionId !== "string" || !result.sessionId)
        throw new Error("ACP session/new returned no session ID")
      if (
        [...this.sessions.values()].some(
          (entry) =>
            entry !== session &&
            entry.binding.engineSessionId === result.sessionId,
        )
      ) {
        this.sessions.delete(input.appSessionId)
        throw new Error("ACP session/new returned an already bound session ID")
      }
      session.binding = {
        ...session.binding,
        engineSessionId: result.sessionId,
      }
    }
    if (this.closed) throw new Error("ACP engine is closed")
    session.connected = true
    for (const pending of this.startupUpdates) {
      if (pending.sessionId === session.binding.engineSessionId) {
        this.emit(session, { type: "session.update", update: pending.update })
      }
    }
    this.startupUpdates = this.openingSessions
      ? this.startupUpdates.filter(
          (pending) => pending.sessionId !== session.binding.engineSessionId,
        )
      : []
    // Preserve initial modes/configuration without leaking the transport binding.
    const initialState = { ...result }
    delete initialState.sessionId
    const update = {
      sessionUpdate: "session_initialized",
      ...initialState,
      ...(this.negotiated.prompt === undefined
        ? {}
        : { promptCapabilities: this.negotiated.prompt }),
    }
    session.controls = applyAcpConfig(session.controls, update)
    this.emit(session, {
      type: "session.update",
      update,
    })
    return session.binding
  }

  async configure(
    binding: EngineBinding,
    configId: string,
    value: string,
  ): Promise<boolean> {
    const session = this.requireSession(binding)
    if (
      session.active ||
      session.configuring ||
      session.preparingPrompt ||
      !session.connected
    )
      return false
    const control = session.controls.find((option) => option.id === configId)
    if (
      control === undefined ||
      !control.options.some((option) => option.value === value)
    )
      return false
    if (control.value === value) return true
    session.configuring = true
    const protocolParams = { sessionId: binding.engineSessionId }
    try {
      if (control.kind === "config") {
        const result = object(
          await this.requireConnection().request("session/set_config_option", {
            ...protocolParams,
            configId,
            value,
          }),
        )
        const update = {
          sessionUpdate: "config_option_update",
          configOptions: result.configOptions,
        }
        session.controls = applyAcpConfig(session.controls, update)
        this.emit(session, { type: "session.update", update })
      } else {
        const mode = control.kind === "mode"
        await this.requireConnection().request(
          mode ? "session/set_mode" : "session/set_model",
          { ...protocolParams, [mode ? "modeId" : "modelId"]: value },
        )
        const update = mode
          ? { sessionUpdate: "current_mode_update", currentModeId: value }
          : { sessionUpdate: "current_model_update", currentModelId: value }
        session.controls = applyAcpConfig(session.controls, update)
        this.emit(session, { type: "session.update", update })
      }
      return true
    } finally {
      delete session.configuring
    }
  }

  async send(
    binding: EngineBinding,
    input: EngineInput,
  ): Promise<EngineSendResult> {
    if (this.closed)
      return { status: "rejected", reason: "ACP engine is closed" }
    const session = this.requireSession(binding)
    const previous = session.requests.get(input.requestId)
    if (previous)
      return previous.status === "accepted"
        ? { ...previous, replayed: true }
        : previous
    if (!session.connected)
      return {
        status: "rejected",
        reason: "External session is disconnected; reconnect before sending",
      }
    if (session.active || session.configuring || session.preparingPrompt)
      return {
        status: "rejected",
        reason: "External agent already has an active prompt",
      }
    let prompt: readonly Record<string, unknown>[]
    session.preparingPrompt = true
    try {
      prompt = await this.preparePrompt(input)
    } catch (error) {
      return {
        status: "rejected",
        reason:
          error instanceof Error
            ? error.message
            : "Could not prepare the engine prompt.",
      }
    } finally {
      delete session.preparingPrompt
    }
    if (!session.connected || this.closed)
      return {
        status: "rejected",
        reason: "External session disconnected before sending.",
      }
    const turnId = `acp_turn_${randomUUID()}`
    const result = { status: "accepted" as const, turnId }
    session.requests.set(input.requestId, result)
    session.active = { turnId, cancelling: false }
    this.emit(session, { type: "turn.status", turnId, status: "accepted" })
    this.emit(session, { type: "turn.status", turnId, status: "running" })
    void this.requireConnection()
      .request("session/prompt", {
        sessionId: binding.engineSessionId,
        prompt,
      })
      .then((value) => {
        const response = object(value)
        if (
          ![
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
            "cancelled",
          ].includes(String(response.stopReason))
        ) {
          throw new Error(
            "ACP prompt response has no valid terminal stopReason",
          )
        }
        if (session.active?.turnId !== turnId) return
        this.cancelPermissions(session)
        delete session.active
        this.emit(session, {
          type: "turn.status",
          turnId,
          status:
            response.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: String(response.stopReason),
        })
      })
      .catch((error: unknown) => {
        if (session.active?.turnId !== turnId) return
        this.cancelPermissions(session)
        delete session.active
        this.emit(session, {
          type: "turn.status",
          turnId,
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return result
  }

  private async preparePrompt(
    input: EngineInput,
  ): Promise<readonly Record<string, unknown>[]> {
    const content = input.content
    if (content === undefined) return [{ type: "text", text: input.text }]
    const capabilities = this.negotiated.prompt
    const prompt: Record<string, unknown>[] = []
    let offset = 0
    for (const element of content.elements) {
      const text = content.text.slice(offset, element.startOffset)
      if (text) prompt.push({ type: "text", text })
      const attachment = content.attachments[element.attachmentIndex]
      if (
        attachment === undefined ||
        "url" in attachment.file ||
        this.options.readAttachment === undefined
      )
        throw new Error(
          "The attached file is unavailable to the external engine.",
        )
      const document = attachment.mediaType === "application/pdf"
      if (document ? !capabilities?.embeddedContext : !capabilities?.image)
        throw new Error(
          document
            ? "This engine does not accept attached documents."
            : "This engine does not accept images.",
        )
      const data = (
        await this.options.readAttachment(attachment.file)
      ).toString("base64")
      if (document) {
        prompt.push({
          type: "resource",
          resource: {
            uri: `yakitori://attachment/${encodeURIComponent(attachment.name)}`,
            mimeType: attachment.mediaType,
            blob: data,
          },
        })
      } else
        prompt.push({ type: "image", data, mimeType: attachment.mediaType })
      offset = element.endOffset
    }
    const text = content.text.slice(offset)
    if (text) prompt.push({ type: "text", text })
    for (const reference of content.references ?? []) {
      if (!capabilities?.embeddedContext)
        throw new Error("This engine does not accept embedded context.")
      prompt.push({
        type: "resource",
        resource: {
          uri: `yakitori://excerpt/${encodeURIComponent(reference.id)}`,
          mimeType: "text/plain",
          text: [reference.comment, reference.text]
            .filter(Boolean)
            .join("\n\n"),
        },
      })
    }
    if (prompt.length === 0) throw new Error("The engine prompt is empty.")
    return prompt
  }

  async cancel(
    binding: EngineBinding,
    turnId: string,
  ): Promise<{ status: "requested" | "not_running" }> {
    const session = this.requireSession(binding)
    if (session.active?.turnId !== turnId) return { status: "not_running" }
    if (session.active.cancelling) return { status: "requested" }
    session.active.cancelling = true
    this.cancelPermissions(session)
    this.requireConnection().notify("session/cancel", {
      sessionId: binding.engineSessionId,
    })
    // No cancellation acknowledgement exists in v1. Keep consuming the tail
    // until session/prompt returns its terminal stopReason.
    return { status: "requested" }
  }

  async respondPermission(
    binding: EngineBinding,
    response: EnginePermissionResponse,
  ): Promise<boolean> {
    const session = this.requireSession(binding)
    if (response.turnId && response.turnId !== session.active?.turnId)
      return false
    const pending = session.permissions.get(response.requestId)
    if (!pending?.options.has(response.optionId)) return false
    session.permissions.delete(response.requestId)
    pending.resolve({
      outcome: { outcome: "selected", optionId: response.optionId },
    })
    return true
  }

  subscribe(
    binding: EngineBinding,
    listener: (event: EngineEvent) => void,
  ): () => void {
    const session = this.requireSession(binding)
    session.listeners.add(listener)
    for (const event of session.backlog.splice(0)) listener(event)
    return () => {
      session.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.connection?.close()
    await Promise.all(this.closing)
  }

  private requireConnection(): AcpStdioConnection {
    if (this.closed) throw new Error("ACP engine is closed")
    if (!this.connection) throw new Error("ACP agent disconnected")
    return this.connection
  }

  private requireSession(binding: EngineBinding): Session {
    const session = this.sessions.get(binding.appSessionId)
    if (
      !session ||
      session.binding.engineId !== binding.engineId ||
      session.binding.engineSessionId !== binding.engineSessionId ||
      session.binding.cwd !== binding.cwd
    ) {
      throw new Error("Unknown ACP session binding")
    }
    return session
  }

  private emit(session: Session, event: EngineEvent): void {
    if (!session.listeners.size) session.backlog.push(event)
    for (const listener of session.listeners) listener(event)
  }

  private notification(method: string, value: unknown): void {
    if (method !== "session/update") return
    const params = object(value)
    const session = [...this.sessions.values()].find(
      (entry) => entry.binding.engineSessionId === params.sessionId,
    )
    const update = object(params.update)
    if (!session) {
      if (this.openingSessions && typeof params.sessionId === "string") {
        // Startup metadata can precede session/new's ID response. Bound the
        // unaffiliated queue so an invalid peer cannot grow it indefinitely.
        if (this.startupUpdates.length >= 32)
          throw new Error(
            "Too many ACP startup updates before session/new completed",
          )
        this.startupUpdates.push({ sessionId: params.sessionId, update })
      }
      return
    }
    const turnId = session.active?.turnId
    session.controls = applyAcpConfig(session.controls, update)
    this.emit(session, {
      type: "session.update",
      update,
      ...(turnId ? { turnId } : {}),
      ...(session.loading ? { replayed: true } : {}),
    })
  }

  private async request(method: string, value: unknown): Promise<unknown> {
    if (method !== "session/request_permission")
      throw new AcpRpcError(-32601, `Unsupported ACP client method: ${method}`)
    const params = object(value)
    const session = [...this.sessions.values()].find(
      (entry) => entry.binding.engineSessionId === params.sessionId,
    )
    if (!session?.active || session.active.cancelling)
      return { outcome: { outcome: "cancelled" } }
    if (!Array.isArray(params.options))
      throw new AcpRpcError(-32602, "Missing permission options")
    const options = params.options.map((value) => {
      const option = object(value)
      if (
        typeof option.optionId !== "string" ||
        typeof option.name !== "string"
      )
        throw new AcpRpcError(-32602, "Invalid permission option")
      return {
        id: option.optionId,
        label: option.name,
        ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
      }
    })
    const toolCall = object(params.toolCall)
    const requestId = `acp_permission_${randomUUID()}`
    const turnId = session.active.turnId
    return new Promise((resolve) => {
      session.permissions.set(requestId, {
        options: new Set(options.map((option) => option.id)),
        resolve,
      })
      this.emit(session, {
        type: "permission.requested",
        turnId,
        requestId,
        options,
        toolCall,
        description:
          typeof toolCall.title === "string"
            ? toolCall.title
            : "External agent requests permission",
      })
    })
  }

  private cancelPermissions(session: Session): void {
    for (const pending of session.permissions.values())
      pending.resolve({ outcome: { outcome: "cancelled" } })
    session.permissions.clear()
  }
}
import {
  applyAcpConfig,
  type AcpConfigControl,
} from "../../../protocol/acp-config.ts"
import type { AssetSource } from "../../../protocol/asset-types.ts"
import type { EnginePromptCapabilities } from "../../../protocol/engine.ts"
