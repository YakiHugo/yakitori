import type {
  SideChatCreate,
  SideChatMessage,
  SideChatSend,
  SideChatSnapshot,
} from "../protocol/side-chat.ts"

export type {
  SideChatCreate,
  SideChatMessage,
  SideChatSend,
  SideChatSnapshot,
} from "../protocol/side-chat.ts"

import { realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { AgentThread } from "../core/agent-thread.ts"
import { ContextManager } from "../core/context-manager.ts"
import type { StoredRolloutItem, StoredThread } from "../core/rollout.ts"
import type {
  AttachmentBytesInput,
  RolloutAssets,
} from "../core/rollout-assets.ts"
import { Session, type TurnProcessor } from "../core/session.ts"
import type { SessionEvent, TurnInputSubmission } from "../core/session-io.ts"
import type { SessionRolloutStore } from "../core/thread-store.ts"
import {
  inputContentAttachments,
  inputContentText,
  replaceInputAttachments,
} from "../core/user-input.ts"
import {
  type InputContent,
  isInputContent,
  type ModelDocumentBlock,
  type ModelImageBlock,
  type ModelMessage,
  type ModelSelection,
  type UserAttachment,
} from "../kernel/events.ts"
import { createSessionId } from "../kernel/ids.ts"
import type { PermissionGate } from "../runtime/permission-gate.ts"

export const sideChatInstructions =
  "This is a temporary side conversation. Answer the new side-chat user's request. Do not spawn or delegate to subagents. You may inspect the workspace to answer questions. Make changes only when the user explicitly asks for those changes in this side conversation."

export type SideChatService = {
  create(input: SideChatCreate): Promise<SideChatSnapshot>
  read(sideChatId: string): SideChatSnapshot
  send(input: SideChatSend): Promise<SideChatSnapshot>
  cancel(sideChatId: string, turnId: string): Promise<SideChatSnapshot>
  remove(sideChatId: string): Promise<void>
  removeForSessionDeletion(
    sessionId: string,
    discardSession: () => Promise<void>,
  ): Promise<void>
  close(): Promise<void>
  importAttachmentPaths(
    sideChatId: string,
    ownerId: string,
    paths: readonly string[],
  ): Promise<readonly UserAttachment[]>
  importAttachmentBytes(
    sideChatId: string,
    ownerId: string,
    items: readonly AttachmentBytesInput[],
  ): Promise<readonly UserAttachment[]>
  resolvePermission(input: {
    sideChatId: string
    turnId: string
    permissionRequestId: string
    behavior: "allow" | "deny"
  }): SideChatSnapshot
}

export class SideChatError extends Error {
  readonly code: "invalid_input" | "not_found" | "conflict"
  constructor(message: string, code: SideChatError["code"] = "invalid_input") {
    super(message)
    this.name = "SideChatError"
    this.code = code
  }
}

type LiveChat = {
  parentSessionId?: string
  thread: AgentThread
  stored: StoredThread
  inheritedHistory: readonly ModelMessage[]
  importing: Set<Promise<unknown>>
  snapshot: SideChatSnapshot
  pump: Promise<void>
  closing: boolean
  requests: Map<
    string,
    { content: InputContent; modelSelection: ModelSelection }
  >
}

export function createSideChatService(options: {
  defaultModel: ModelSelection
  defaultCwd: string
  mateId: string
  mateRevisionId: string
  createProcessor(stored: StoredThread): TurnProcessor | Promise<TurnProcessor>
  readSource?(id: string): Promise<StoredThread | undefined>
  rolloutAssets?: RolloutAssets
  releaseAssets?(id: string): Promise<void>
  resolvePermission?: PermissionGate["resolve"]
  now?: () => number
  changed(snapshot: SideChatSnapshot): void
  reportError(error: unknown): void
}): SideChatService {
  const chats = new Map<string, LiveChat>()
  const creating = new Set<Promise<SideChatSnapshot>>()
  const deletingParents = new Set<string>()
  const now = options.now ?? Date.now
  const inactivityMs = 24 * 60 * 60 * 1_000
  const expiredChatError = () =>
    new SideChatError(
      "This side conversation is read-only after 24 hours of inactivity.",
      "conflict",
    )
  let closed = false
  const requireChat = (id: string): LiveChat => {
    const chat = chats.get(id)
    if (chat === undefined || chat.closing)
      throw new SideChatError(
        "This temporary conversation is no longer available.",
        "not_found",
      )
    return chat
  }
  const snapshot = (chat: LiveChat): SideChatSnapshot =>
    structuredClone(chat.snapshot)
  const publish = (chat: LiveChat) => {
    chat.snapshot.revision += 1
    if (!chat.closing) options.changed(snapshot(chat))
  }

  const service: SideChatService = {
    create(input) {
      if (closed)
        return Promise.reject(
          new SideChatError("Side conversations are closed.", "conflict"),
        )
      const operation = (async () => {
        const sourceChat =
          input.sourceSessionId === undefined
            ? undefined
            : chats.get(input.sourceSessionId)
        if (sourceChat?.closing)
          throw new SideChatError(
            "The source conversation is no longer available.",
            "not_found",
          )
        const source =
          input.sourceSessionId === undefined
            ? undefined
            : structuredClone(
                sourceChat?.stored ??
                  (await options.readSource?.(input.sourceSessionId)),
              )
        if (input.sourceSessionId !== undefined && source === undefined)
          throw new SideChatError(
            "The source conversation is no longer available.",
            "not_found",
          )
        const parentSessionId =
          sourceChat === undefined
            ? input.sourceSessionId
            : sourceChat.parentSessionId
        const completedTurns = new Set(
          source?.rollout.flatMap(({ item }) =>
            item.type === "turn_completed" && item.outcome === "completed"
              ? [item.turnId]
              : [],
          ),
        )
        const inherited = [
          ...(sourceChat?.inheritedHistory ?? []),
          ...(source === undefined
            ? []
            : ContextManager.fromStoredThread(source)
                .snapshot()
                .history.filter(
                  (entry) =>
                    completedTurns.has(entry.turnId) &&
                    entry.item.role !== "developer",
                )
                .map((entry) => entry.item)),
        ]
        // Preserve portable sources until the side conversation owns independent
        // copies below. External URLs need no local ownership transfer.
        let inheritedHistory: readonly ModelMessage[] = inherited
        let attachmentNumber = 0
        const quoteAttachment = (
          block: ModelImageBlock | ModelDocumentBlock,
        ) => ({
          type: block.type,
          mediaType: block.mediaType,
          ...(block.type === "document" ? { name: block.name } : {}),
          referenceAttachment: ++attachmentNumber,
        })
        const quotedHistory = inheritedHistory.map((message) => {
          if (message.role === "user" || message.role === "tool")
            return {
              ...message,
              content: message.content.map((block) =>
                block.type === "image" || block.type === "document"
                  ? quoteAttachment(block)
                  : block,
              ),
            }
          return message
        })
        const referenceAttachments = inheritedHistory.flatMap((message) =>
          message.role === "user" || message.role === "tool"
            ? [...message.content].filter(
                (block): block is ModelImageBlock | ModelDocumentBlock =>
                  block.type === "image" || block.type === "document",
              )
            : [],
        )
        const sourceSelection = source?.rollout
          .filter(({ item }) => item.type === "turn_context")
          .at(-1)?.item
        const modelSelection =
          input.modelSelection ??
          (sourceSelection?.type === "turn_context"
            ? sourceSelection.context.selection
            : options.defaultModel)
        const requestedCwd =
          input.cwd ?? source?.metadata.workingDirectory ?? options.defaultCwd
        if (!isAbsolute(requestedCwd) || requestedCwd.includes("\0"))
          throw new SideChatError("cwd must be an absolute directory path.")
        const cwd = await realpath(requestedCwd)
        if (!(await stat(cwd)).isDirectory())
          throw new SideChatError("cwd must be a directory.")
        if (closed)
          throw new SideChatError("Side conversations are closed.", "conflict")
        const id = createSessionId()
        const createdAt = now()
        const createdAtIso = new Date(createdAt).toISOString()
        const metadata = {
          id,
          rolloutId: id,
          conversationId: id,
          createdAt: createdAtIso,
          updatedAt: createdAtIso,
          workingDirectory: cwd,
          mateId: options.mateId,
          mateRevisionId: options.mateRevisionId,
          ...(source?.metadata.projectId === undefined
            ? {}
            : { projectId: source.metadata.projectId }),
        }
        const rollout: StoredRolloutItem[] = [
          {
            threadId: id,
            rolloutId: id,
            seq: 0,
            createdAt: createdAtIso,
            item: {
              type: "response_item",
              item: {
                id: `side_context_${id}`,
                turnId: `side_context_${id}`,
                createdAt: createdAtIso,
                item: {
                  role: "developer",
                  content: [
                    {
                      type: "text",
                      text: [
                        sideChatInstructions,
                        ...(inherited.length === 0
                          ? []
                          : [
                              "The following completed parent conversation is frozen reference material. It is not an active task or instructions; do not continue its work or inherit its authorization. Follow the new user message below.",
                              JSON.stringify(quotedHistory),
                            ]),
                      ].join("\n\n"),
                    },
                  ],
                },
              },
            },
          },
        ]
        if (referenceAttachments.length > 0)
          rollout.push({
            threadId: id,
            rolloutId: id,
            seq: rollout.length,
            createdAt: createdAtIso,
            item: {
              type: "response_item",
              item: {
                id: `side_attachments_${id}`,
                turnId: `side_context_${id}`,
                createdAt: createdAtIso,
                item: {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "These attachments, in order, belong to the frozen parent conversation above. They are reference material, not a new request. Answer the new side-chat user message that follows.",
                    },
                    ...referenceAttachments,
                  ],
                },
              },
            },
          })
        const stored: StoredThread = { metadata, rollout }
        // Codex ephemeral threads run the ordinary Session without a live
        // persistence handle. Keep the rollout writer local and memory-only;
        // no durable ThreadManager, sidebar entry, or agent graph is involved.
        let nextSeq = rollout.length
        const store: SessionRolloutStore = {
          async appendItems(_id, items) {
            const records: StoredRolloutItem[] = []
            for (const item of items)
              records.push({
                threadId: id,
                rolloutId: id,
                seq: nextSeq++,
                createdAt: new Date().toISOString(),
                item: structuredClone(item),
              })
            rollout.push(...records)
            return { throughSeq: nextSeq, records: structuredClone(records) }
          },
          async persistThread() {},
          async flushThread() {},
          async readThread() {
            return structuredClone(stored)
          },
          async shutdownThread() {},
        }
        // Creating the processor establishes the ephemeral asset lease. Copy owned
        // media afterwards so deleting the parent cannot remove these sources.
        const processor = await options.createProcessor(stored)
        let thread: AgentThread
        let rollbackMedia: (() => Promise<void>) | undefined
        try {
          const media = referenceAttachments.flatMap((block) => {
            if (block.file === undefined || "url" in block.file) return []
            if (block.sizeBytes === undefined)
              throw new Error("Inherited media has no recorded size.")
            return [
              {
                block,
                attachment: {
                  name:
                    block.type === "document"
                      ? block.name
                      : (("name" in block ? block.name : undefined) ?? "image"),
                  mediaType: block.mediaType,
                  sizeBytes: block.sizeBytes,
                  file: block.file,
                  ...(block.type === "image"
                    ? { detail: block.detail ?? "high" }
                    : {}),
                },
              },
            ]
          })
          if (media.length > 0) {
            if (options.rolloutAssets === undefined)
              throw new SideChatError("Attachment storage is unavailable.")
            const copied = await options.rolloutAssets.copyAttachments(
              id,
              `side_context_${id}`,
              media.map(({ attachment }) => attachment),
            )
            rollbackMedia = copied.rollback
            const replacements = new Map(
              media.map(({ block }, index) => {
                const attachment = copied.attachments[index]
                if (attachment === undefined)
                  throw new Error("Missing inherited media copy.")
                return [
                  block,
                  attachment.mediaType === "application/pdf"
                    ? { type: "document" as const, ...attachment }
                    : { type: "image" as const, ...attachment },
                ]
              }),
            )
            const replaceMedia = (message: ModelMessage): ModelMessage => {
              if (message.role !== "user" && message.role !== "tool")
                return message
              return {
                ...message,
                content: message.content.map((block) =>
                  block.type === "text" || block.file === undefined
                    ? block
                    : (replacements.get(block) ?? block),
                ),
              }
            }
            inheritedHistory = inheritedHistory.map(replaceMedia)
            for (const [index, record] of rollout.entries()) {
              const item = record.item
              if (
                item.type === "response_item" &&
                item.item.item.role === "user"
              )
                rollout[index] = {
                  ...record,
                  item: {
                    ...item,
                    item: {
                      ...item.item,
                      item: replaceMedia(item.item.item),
                    },
                  },
                }
            }
          }
          if (closed)
            throw new SideChatError(
              "Side conversations are closed.",
              "conflict",
            )
          if (
            parentSessionId !== undefined &&
            deletingParents.has(parentSessionId)
          )
            throw new SideChatError(
              "The source conversation is no longer available.",
              "not_found",
            )
          thread = new AgentThread(new Session({ stored, store, processor }))
        } catch (error) {
          try {
            await processor.dispose?.()
          } finally {
            try {
              await rollbackMedia?.()
            } finally {
              await options.releaseAssets?.(id)
            }
          }
          throw error
        }
        const chat: LiveChat = {
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
          thread,
          stored,
          inheritedHistory,
          importing: new Set(),
          snapshot: {
            id,
            revision: 0,
            cwd,
            modelSelection: structuredClone(modelSelection),
            expiresAt: new Date(createdAt + inactivityMs).toISOString(),
            messages: [],
          },
          pump: Promise.resolve(),
          closing: false,
          requests: new Map(),
        }
        chats.set(id, chat)
        chat.pump = (async () => {
          for (;;) {
            const event = await thread.nextEvent()
            if (event === undefined) return
            if (reduceChat(chat, event)) publish(chat)
          }
        })()
        void chat.pump.catch(options.reportError)
        return snapshot(chat)
      })()
      creating.add(operation)
      const sourceChat =
        input.sourceSessionId === undefined
          ? undefined
          : chats.get(input.sourceSessionId)
      sourceChat?.importing.add(operation)
      const finish = () => {
        creating.delete(operation)
        sourceChat?.importing.delete(operation)
      }
      void operation.then(finish, finish)
      return operation
    },
    read(id) {
      return snapshot(requireChat(id))
    },
    async send(input) {
      const chat = requireChat(input.sideChatId)
      if (!isInputContent(input.content))
        throw new SideChatError(
          "content must contain valid text, editor elements and attachments.",
        )
      const attachments = inputContentAttachments(input.content)
      if (
        (!inputContentText(input.content).trim() &&
          !input.content.references?.length &&
          attachments.length === 0) ||
        !input.requestId.trim()
      )
        throw new SideChatError(
          "A message or attachment and requestId are required.",
        )
      const originalContent = structuredClone(input.content)
      const selection = input.modelSelection ?? chat.snapshot.modelSelection
      const previous = chat.requests.get(input.requestId)
      if (previous !== undefined) {
        if (
          JSON.stringify(previous.content) !==
            JSON.stringify(originalContent) ||
          (input.modelSelection !== undefined &&
            (["provider", "model", "effort", "speed"] as const).some(
              (key) =>
                previous.modelSelection[key] !== input.modelSelection?.[key],
            ))
        )
          throw new SideChatError(
            "requestId already belongs to a different message.",
            "conflict",
          )
        return snapshot(chat)
      }
      if (now() >= Date.parse(chat.snapshot.expiresAt)) throw expiredChatError()
      if (chat.thread.status !== "idle")
        throw new SideChatError(
          "Wait for the current response or stop it first.",
          "conflict",
        )
      const operation = (async () => {
        const ownsFiles = attachments.some(
          (attachment) => !("url" in attachment.file),
        )
        const promotion = !ownsFiles
          ? undefined
          : await options.rolloutAssets?.promoteAttachments(
              chat.snapshot.id,
              input.requestId,
              attachments,
            )
        if (ownsFiles && promotion === undefined)
          throw new SideChatError("Attachment storage is unavailable.")
        const content =
          promotion === undefined
            ? originalContent
            : replaceInputAttachments(originalContent, promotion.attachments)
        // Promotion may outlive the deadline; admission must still happen before it.
        if (now() >= Date.parse(chat.snapshot.expiresAt)) {
          await promotion?.rollback()
          throw expiredChatError()
        }
        let result: TurnInputSubmission
        try {
          result = await chat.thread.startIfIdle({
            submissionId: input.requestId,
            modelSelection: selection,
            content,
          })
        } catch (error) {
          await promotion?.rollback()
          throw error
        }
        if (result.type === "not_submitted") {
          await promotion?.rollback()
          throw new SideChatError(
            "The side conversation could not accept this message.",
            "conflict",
          )
        }
        chat.snapshot.expiresAt = new Date(now() + inactivityMs).toISOString()
        chat.requests.set(input.requestId, {
          content: originalContent,
          modelSelection: structuredClone(selection),
        })
        chat.snapshot.modelSelection = structuredClone(selection)
        if (
          !chat.snapshot.messages.some(
            (message) => message.id === input.requestId,
          )
        ) {
          const message: SideChatMessage = {
            id: input.requestId,
            turnId: result.turnId,
            role: "user",
            content,
            streaming: false,
          }
          const responseIndex = chat.snapshot.messages.findIndex(
            (entry) => entry.turnId === result.turnId,
          )
          if (responseIndex < 0) chat.snapshot.messages.push(message)
          else chat.snapshot.messages.splice(responseIndex, 0, message)
        }
        publish(chat)
        // Admission is committed before staging cleanup. A failed unlink must
        // not erase the accepted input or turn its idempotent reply into failure.
        if (promotion !== undefined) {
          try {
            await options.rolloutAssets?.discardDraftAttachments(attachments)
          } catch (error) {
            options.reportError(error)
          }
        }
        return snapshot(chat)
      })()
      chat.importing.add(operation)
      try {
        return await operation
      } finally {
        chat.importing.delete(operation)
      }
    },
    async importAttachmentPaths(id, ownerId, paths) {
      const chat = requireChat(id)
      if (now() >= Date.parse(chat.snapshot.expiresAt)) throw expiredChatError()
      if (options.rolloutAssets === undefined)
        throw new SideChatError("Attachment storage is unavailable.")
      const operation = options.rolloutAssets.importAttachmentPaths(
        id,
        ownerId,
        paths,
      )
      chat.importing.add(operation)
      try {
        return await operation
      } finally {
        chat.importing.delete(operation)
      }
    },
    async importAttachmentBytes(id, ownerId, items) {
      const chat = requireChat(id)
      if (now() >= Date.parse(chat.snapshot.expiresAt)) throw expiredChatError()
      if (options.rolloutAssets === undefined)
        throw new SideChatError("Attachment storage is unavailable.")
      const operation = options.rolloutAssets.importAttachmentBytes(
        id,
        ownerId,
        items,
      )
      chat.importing.add(operation)
      try {
        return await operation
      } finally {
        chat.importing.delete(operation)
      }
    },
    resolvePermission(input) {
      const chat = requireChat(input.sideChatId)
      if (
        !options.resolvePermission?.({ ...input, sessionId: input.sideChatId })
      )
        throw new SideChatError(
          "The permission request is no longer active.",
          "not_found",
        )
      return snapshot(chat)
    },
    async cancel(id, turnId) {
      const chat = requireChat(id)
      await chat.thread.interruptTurn(turnId)
      return snapshot(chat)
    },
    async remove(id) {
      const chat = requireChat(id)
      chat.closing = true
      try {
        await chat.thread.shutdownAndWait()
        await chat.pump
      } finally {
        await Promise.allSettled([...chat.importing])
        try {
          await options.releaseAssets?.(id)
        } finally {
          chats.delete(id)
        }
      }
    },
    async removeForSessionDeletion(sessionId, discardSession) {
      deletingParents.add(sessionId)
      try {
        await Promise.allSettled([...creating])
        const results = await Promise.allSettled(
          [...chats]
            .filter(([, chat]) => chat.parentSessionId === sessionId)
            .map(([id]) => service.remove(id)),
        )
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        )
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            "Failed to close side conversations.",
          )
        await discardSession()
        // A fork started while the durable session was being discarded must
        // finish (and observe the deletion gate) before it is released.
        await Promise.allSettled([...creating])
      } finally {
        deletingParents.delete(sessionId)
      }
    },
    async close() {
      if (closed) return
      closed = true
      await Promise.allSettled([...creating])
      const results = await Promise.allSettled(
        [...chats.keys()].map((id) => service.remove(id)),
      )
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )
      if (errors.length > 0)
        throw new AggregateError(errors, "Failed to close side conversations.")
    },
  }
  return service
}

function reduceChat(chat: LiveChat, event: SessionEvent): boolean {
  const state = chat.snapshot
  if (event.type === "permission") {
    const permission = event.event
    state.pendingPermissions = (state.pendingPermissions ?? []).filter(
      (entry) => entry.permissionRequestId !== permission.permissionRequestId,
    )
    if (permission.type === "permission.requested")
      state.pendingPermissions = [...state.pendingPermissions, permission]
    return true
  }
  if (event.type === "turn.started") {
    state.activeTurnId = event.input.submissionId
    delete state.error
    return true
  }
  if (event.type === "model.stream" && event.kind === "assistant") {
    const existing = state.messages.find(
      (message) => message.id === event.itemId,
    )
    if (existing?.role === "assistant") {
      existing.text += event.delta
      existing.streaming = true
    } else
      state.messages.push({
        id: event.itemId,
        turnId: event.turnId,
        role: "assistant",
        text: event.delta,
        streaming: true,
      })
    return true
  }
  if (event.type === "runtime.warning" && event.code === "model.retry") {
    const itemIds = event.details?.discardedResponseItemIds
    const discarded = Array.isArray(itemIds) ? itemIds : []
    state.messages = state.messages.filter(
      (message) =>
        !discarded.includes(message.id) ||
        message.turnId !== event.turnId ||
        !message.streaming,
    )
    return true
  }
  if (event.type === "rollout.appended") {
    let changed = false
    for (const { item } of event.records) {
      if (item.type !== "response_item" || item.item.item.role !== "assistant")
        continue
      const text = item.item.item.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
      if (!text) continue
      const existing = state.messages.find(
        (message) => message.id === item.item.id,
      )
      if (existing?.role === "assistant") {
        existing.text = text
        existing.streaming = false
      } else
        state.messages.push({
          id: item.item.id,
          turnId: item.item.turnId,
          role: "assistant",
          text,
          streaming: false,
        })
      changed = true
    }
    return changed
  }
  if (
    event.type === "turn.completed" ||
    event.type === "turn.interrupted" ||
    event.type === "turn.failed"
  ) {
    if (state.activeTurnId === event.input.submissionId)
      delete state.activeTurnId
    for (const message of state.messages) {
      if (message.turnId === event.input.submissionId) message.streaming = false
    }
    if (event.type === "turn.failed") state.error = event.error.message
    return true
  }
  return false
}
