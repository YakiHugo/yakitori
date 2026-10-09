import { LoaderCircle, MessageCirclePlus } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ImageAttachment } from "../../protocol/asset-types.ts"
import type { ModelSelection } from "../../protocol/events.ts"
import type { SideChatSnapshot } from "../../protocol/side-chat.ts"
import type { InputContent, InputDraft } from "../../protocol/user-input.ts"
import {
  inputContent,
  inputContentAttachments,
} from "../../protocol/user-input.ts"
import {
  attachmentUrl,
  discardDraftAttachments,
  requireDesktopBridge,
} from "../composer-attachments.ts"
import { contextSourceAttributes } from "../conversation-context.ts"
import { inputAttachmentOwnership } from "../input-attachment-ownership.ts"
import {
  hasInputDraft,
  inputDisplayParts,
  sameInputDraft,
  textInputDraft,
  trimInputDraft,
} from "../input-draft.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import {
  normalizeKimiModelSelection,
  resolveEffectiveModel,
  useAppStore,
} from "../store/app-store.ts"
import {
  useWorkspaceStore,
  type WorkspaceTab,
} from "../store/workspace-store.ts"
import { ApprovalRequests } from "./approval-bar.tsx"
import {
  type ComposerAttachmentImport,
  ComposerSurface,
} from "./composer-surface.tsx"
import { ImageLightbox } from "./image-lightbox.tsx"
import { MarkdownView } from "./markdown.tsx"
import { ModelSelector } from "./model-selector.tsx"
import { openPdfAttachment, PdfAttachmentCard } from "./pdf-attachment.tsx"
import { PromptEditor } from "./prompt-editor.tsx"
import { ContextExcerptChips } from "./selection-actions.tsx"

export function SideChatPanel({
  tab,
  cwd,
  apiBase,
  active,
}: Readonly<{
  tab: Extract<WorkspaceTab, { kind: "chat" }>
  cwd?: string | undefined
  apiBase: string
  active: boolean
}>) {
  const [chat, setChat] = useState<SideChatSnapshot>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [expiredByServer, setExpiredByServer] = useState(false)
  const [, setExpiryTick] = useState(0)
  const [readingAttachments, setReadingAttachments] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string>()
  const [previewImage, setPreviewImage] = useState<ImageAttachment>()
  const [resolvingPermissions, setResolvingPermissions] = useState<
    ReadonlySet<string>
  >(new Set())
  const [sessionSkills] = useState(() => useAppStore.getState().sessionSkills)
  const providers = useAppStore((state) => state.providers)
  const sending = useRef(false)
  const [stopping, setStopping] = useState(false)
  const [selection, setSelection] = useState<ModelSelection | undefined>(() => {
    const state = useAppStore.getState()
    return normalizeKimiModelSelection(
      resolveEffectiveModel({
        sessionCurrent:
          tab.sourceSessionId === undefined
            ? state.draftModelSelection
            : state.modelSelections[tab.sourceSessionId],
        userPreference: state.userPreference,
        defaultProvider: state.defaultProvider,
        defaultModel: state.defaultModel,
        providers: state.providers,
      }),
      state.providers,
    )
  })
  const initialSelection = useRef(selection)
  const initialCwd = useRef(cwd)
  const sourceSessionId = useRef(tab.sourceSessionId)
  const creating = useRef<Promise<SideChatSnapshot | undefined> | undefined>(
    undefined,
  )
  const chatRef = useRef<SideChatSnapshot | undefined>(undefined)
  const disposed = useRef(false)
  const viewport = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const attempt = useRef<
    | {
        content: InputContent
        requestId: string
        modelSelection: ModelSelection | undefined
      }
    | undefined
  >(undefined)
  const client = getAppRpcClient(apiBase)
  const updateDraft = useWorkspaceStore((state) => state.updateChatDraft)
  const updateStatus = useWorkspaceStore((state) => state.updateChatStatus)
  const expired =
    expiredByServer ||
    (chat !== undefined && Date.now() >= Date.parse(chat.expiresAt))
  const isExpired = (snapshot: SideChatSnapshot) =>
    Date.now() >= Date.parse(snapshot.expiresAt)
  const latestTab = () => {
    const state = useWorkspaceStore.getState()
    const current = state.tabs.find((entry) => entry.id === tab.id)
    return current?.kind === "chat" ? current : undefined
  }

  const applySnapshot = useCallback(
    (next: SideChatSnapshot) => {
      if (disposed.current) return
      if (chatRef.current && next.revision < chatRef.current.revision) return
      const sent = attempt.current
      const accepted =
        sent &&
        next.messages.find(
          (message) => message.role === "user" && message.id === sent.requestId,
        )
      if (sent && accepted?.role === "user") {
        inputAttachmentOwnership.promote(
          apiBase,
          sent.content,
          accepted.content,
        )
        const current = useWorkspaceStore
          .getState()
          .tabs.find((candidate) => candidate.id === tab.id)
        if (current?.kind === "chat")
          updateDraft(
            tab.id,
            inputAttachmentOwnership.resolveDraft(apiBase, current.draft),
            current.excerpts,
          )
      }
      const previousExpiry = chatRef.current?.expiresAt
      chatRef.current = next
      // A server rejection remains authoritative when the local clock lags.
      // Only another admitted message extending the lease can reopen this chat.
      if (
        previousExpiry !== undefined &&
        Date.parse(next.expiresAt) > Date.parse(previousExpiry) &&
        Date.now() < Date.parse(next.expiresAt)
      )
        setExpiredByServer(false)
      setChat(next)
    },
    [apiBase, tab.id, updateDraft],
  )
  useEffect(() => {
    disposed.current = false
    const unsubscribe = client.subscribeToSideChatChanges((next) => {
      if (!chatRef.current) return
      if (next === undefined) {
        void client
          .request("sideChat/read", { sideChatId: chatRef.current.id })
          .then(applySnapshot, (cause: unknown) => {
            if (!disposed.current)
              setError(cause instanceof Error ? cause.message : String(cause))
          })
      } else if (next.id === chatRef.current.id) applySnapshot(next)
    })
    return () => {
      disposed.current = true
      unsubscribe()
      const id = chatRef.current?.id
      if (id)
        void client
          .request("sideChat/close", { sideChatId: id })
          .catch((cause: unknown) =>
            console.error("Could not close side chat.", cause),
          )
    }
  }, [client, applySnapshot])
  useEffect(() => {
    if (
      active &&
      chat?.revision !== undefined &&
      pinned.current &&
      viewport.current
    )
      viewport.current.scrollTop = viewport.current.scrollHeight
  }, [active, chat?.revision])

  useEffect(() => {
    if (!chat?.expiresAt) return
    let timeout: number
    const schedule = () => {
      const remaining = Date.parse(chat.expiresAt) - Date.now()
      if (remaining <= 0) {
        setExpiryTick((tick) => tick + 1)
        return
      }
      // setTimeout clamps long delays; schedule again when necessary.
      timeout = window.setTimeout(
        schedule,
        Math.min(remaining + 1, 2_147_483_647),
      )
    }
    schedule()
    return () => window.clearTimeout(timeout)
  }, [chat?.expiresAt])

  useEffect(() => {
    const currentError = error ?? chat?.error
    updateStatus(tab.id, {
      hasMessages: (chat?.messages.length ?? 0) > 0,
      expired,
      ...(chat?.activeTurnId ? { activeTurnId: chat.activeTurnId } : {}),
      ...(chat?.expiresAt ? { expiresAt: chat.expiresAt } : {}),
      ...(currentError === undefined ? {} : { error: currentError }),
    })
  }, [
    tab.id,
    chat?.messages.length,
    chat?.activeTurnId,
    chat?.expiresAt,
    chat?.error,
    expired,
    error,
    updateStatus,
  ])

  const ensureChat = useCallback(
    async (modelSelection = initialSelection.current) => {
      if (chatRef.current) return chatRef.current
      if (creating.current) return creating.current
      const creation = (async () => {
        const current = await client.request("sideChat/create", {
          ...(initialCwd.current === undefined
            ? {}
            : { cwd: initialCwd.current }),
          ...(sourceSessionId.current === undefined
            ? {}
            : { sourceSessionId: sourceSessionId.current }),
          ...(modelSelection === undefined ? {} : { modelSelection }),
        })
        if (disposed.current) {
          await client.request("sideChat/close", { sideChatId: current.id })
          return undefined
        }
        applySnapshot(current)
        return current
      })()
      creating.current = creation
      try {
        return await creation
      } finally {
        creating.current = undefined
      }
    },
    [client, applySnapshot],
  )

  // Opening the tab chooses the fork point. Waiting until the first send
  // would accidentally include parent turns completed after the tab opened.
  useEffect(() => {
    void ensureChat().catch((cause: unknown) => {
      if (!disposed.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [ensureChat])

  const importAttachments: ComposerAttachmentImport = async (
    prepare,
    validate,
  ) => {
    if (readingAttachments || sending.current || expired) return
    setReadingAttachments(true)
    setAttachmentError(undefined)
    let release: (() => Promise<void>) | undefined
    try {
      validate?.()
      requireDesktopBridge()
      const prepared = await prepare()
      if (!prepared) return
      release = prepared.cleanup
      const current = await ensureChat()
      if (!current || isExpired(current)) return
      const images = await prepared.collect(current.id)
      const latest = latestTab()
      const added = images
      if (
        disposed.current ||
        !latest ||
        expiredByServer ||
        isExpired(chatRef.current ?? current)
      ) {
        await discardDraftAttachments(added)
        return
      }
      return added
    } catch (cause) {
      if (!disposed.current)
        setAttachmentError(
          cause instanceof Error ? cause.message : String(cause),
        )
    } finally {
      try {
        await release?.()
      } catch (cause) {
        if (!disposed.current)
          setAttachmentError(
            cause instanceof Error ? cause.message : String(cause),
          )
      }
      if (!disposed.current) setReadingAttachments(false)
    }
  }

  const send = async (parts: InputDraft = trimInputDraft(tab.draft)) => {
    if (
      sending.current ||
      chatRef.current?.activeTurnId ||
      expiredByServer ||
      (chatRef.current !== undefined && isExpired(chatRef.current)) ||
      (!hasInputDraft(parts) && tab.excerpts.length === 0)
    )
      return
    const originalDraft = tab.draft
    const originalExcerpts = tab.excerpts
    const modelSelection = selection ?? chatRef.current?.modelSelection
    const payload = {
      content: inputContent(
        parts,
        { ...(originalExcerpts.length ? { references: originalExcerpts } : {}) }
          .references,
      ),
      modelSelection,
    }
    const request =
      attempt.current &&
      JSON.stringify({
        content: attempt.current.content,
        modelSelection: attempt.current.modelSelection,
      }) === JSON.stringify(payload)
        ? attempt.current
        : { ...payload, requestId: `side_input_${crypto.randomUUID()}` }
    attempt.current = request
    sending.current = true
    setPending(true)
    setError(undefined)
    pinned.current = true
    try {
      const current = await ensureChat(request.modelSelection)
      if (!current) return
      if (isExpired(current)) {
        setExpiryTick((tick) => tick + 1)
        return
      }
      request.modelSelection ??= current.modelSelection
      setSelection(
        (currentSelection) => currentSelection ?? request.modelSelection,
      )
      const response = await client.request("sideChat/send", {
        sideChatId: current.id,
        ...request,
        modelSelection: request.modelSelection ?? current.modelSelection,
      })
      if (disposed.current) return
      const accepted = response.messages.find(
        (message) =>
          message.id === request.requestId && message.role === "user",
      )
      if (accepted?.role !== "user")
        throw new Error("Side chat acknowledgement omitted its accepted input.")
      inputAttachmentOwnership.promote(
        apiBase,
        request.content,
        accepted.content,
      )
      applySnapshot(response)
      const latest = latestTab()
      // An ACK only consumes the exact draft that was submitted. Selection
      // actions and uploads may have staged new input while it was in flight.
      if (
        latest !== undefined &&
        sameInputDraft(
          inputAttachmentOwnership.resolveDraft(apiBase, latest.draft),
          inputAttachmentOwnership.resolveDraft(apiBase, originalDraft),
        ) &&
        latest.excerpts === originalExcerpts
      )
        updateDraft(tab.id, textInputDraft(""), [])
      else if (latest)
        updateDraft(
          tab.id,
          inputAttachmentOwnership.resolveDraft(apiBase, latest.draft),
          latest.excerpts,
        )
      attempt.current = undefined
    } catch (cause) {
      if (!disposed.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
        if (
          cause instanceof Error &&
          (/expired/i.test(cause.message) ||
            cause.message.includes("read-only after 24 hours of inactivity"))
        ) {
          setExpiredByServer(true)
          const id = chatRef.current?.id
          if (id)
            void client
              .request("sideChat/read", { sideChatId: id })
              .then(applySnapshot, () => {})
        }
      }
    } finally {
      sending.current = false
      if (!disposed.current) setPending(false)
    }
  }
  const cancel = async () => {
    if (!chat?.activeTurnId || stopping) return
    setStopping(true)
    try {
      applySnapshot(
        await client.request("sideChat/cancel", {
          sideChatId: chat.id,
          turnId: chat.activeTurnId,
        }),
      )
    } catch (cause) {
      if (!disposed.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!disposed.current) setStopping(false)
    }
  }
  const resolvePermission = async (
    turnId: string,
    permissionRequestId: string,
    behavior: "allow" | "deny",
  ) => {
    if (!chat || resolvingPermissions.has(permissionRequestId)) return
    setResolvingPermissions(
      (current) => new Set([...current, permissionRequestId]),
    )
    try {
      applySnapshot(
        await client.request("sideChat/resolvePermission", {
          sideChatId: chat.id,
          turnId,
          permissionRequestId,
          behavior,
        }),
      )
    } catch (cause) {
      if (!disposed.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!disposed.current)
        setResolvingPermissions(
          (current) =>
            new Set([...current].filter((id) => id !== permissionRequestId)),
        )
    }
  }

  const modelEntry = providers
    .find((provider) => provider.name === selection?.provider)
    ?.models.find((model) => model.id === selection?.model)
  return (
    <div className="side-chat-panel" data-side-chat-id={tab.id}>
      <div
        ref={viewport}
        role="log"
        className="side-chat-transcript"
        aria-label="Side chat messages"
        onScroll={() => {
          const element = viewport.current
          if (element)
            pinned.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              48
        }}
      >
        {chat?.messages.length ? (
          chat.messages.map((message) => (
            <article
              key={message.id}
              className={`side-chat-message ${message.role === "user" ? "side-chat-user" : ""}`}
              {...contextSourceAttributes({
                kind: "message",
                label:
                  message.role === "user"
                    ? "Side chat message"
                    : "Side chat response",
                sessionId: chat.id,
                messageId: message.id,
              })}
            >
              {message.role === "user" ? (
                <>
                  {message.content.references?.length ? (
                    <ContextExcerptChips
                      excerpts={message.content.references}
                    />
                  ) : null}
                  {inputDisplayParts(message.content).map((part, index) =>
                    part.type === "text" ? (
                      <MarkdownView
                        apiBase={apiBase}
                        // biome-ignore lint/suspicious/noArrayIndexKey: Admitted user parts are immutable within this message ID.
                        key={`${message.id}:${index}`}
                        text={part.text}
                        className="markdown side-chat-user-bubble"
                        workspaceRoot={chat.cwd}
                      />
                    ) : part.type === "document" ? (
                      <PdfAttachmentCard
                        // biome-ignore lint/suspicious/noArrayIndexKey: Part slots distinguish repeated references to the same asset.
                        key={`${message.id}:${index}`}
                        attachment={part}
                        apiBase={apiBase}
                      />
                    ) : (
                      <button
                        type="button"
                        // biome-ignore lint/suspicious/noArrayIndexKey: Admitted user parts are immutable within this message ID.
                        key={`${message.id}:${index}`}
                        aria-label={`Preview ${part.name}`}
                        onClick={() => setPreviewImage(part)}
                        className="cursor-zoom-in"
                      >
                        <img
                          src={attachmentUrl(part, apiBase)}
                          alt={part.name}
                          className="max-h-40 rounded-lg object-contain"
                        />
                      </button>
                    ),
                  )}
                </>
              ) : (
                <MarkdownView
                  apiBase={apiBase}
                  text={message.text}
                  streaming={message.streaming}
                  className="markdown"
                  workspaceRoot={chat.cwd}
                />
              )}
            </article>
          ))
        ) : (
          <div className="workspace-empty side-chat-empty">
            <MessageCirclePlus size={34} strokeWidth={1.5} />
            <h3>Side chat</h3>
            <p>
              Ask a question alongside your work. Side chats are temporary and
              disappear when you close the app.
            </p>
          </div>
        )}
        {chat?.activeTurnId && (
          <div
            role="status"
            className="flex items-center gap-2 py-3 text-xs text-muted-foreground"
          >
            <LoaderCircle size={13} className="animate-spin" /> Responding…
          </div>
        )}
      </div>
      {(error || chat?.error) && (
        <p role="alert" className="mx-4 mb-2 text-xs text-destructive">
          {error ?? chat?.error}
        </p>
      )}
      <ApprovalRequests
        pending={chat?.pendingPermissions ?? []}
        isResolving={(id) => resolvingPermissions.has(id)}
        onResolve={(turnId, id, behavior) =>
          void resolvePermission(turnId, id, behavior)
        }
      />
      {expired ? (
        <div className="side-chat-expired" role="status">
          <p>Side chat expired. Start a new side chat to continue.</p>
          {hasInputDraft(tab.draft) ? (
            <PromptEditor
              label="Unsent side chat draft"
              apiBase={apiBase}
              value={tab.draft}
              disabled
              onChange={() => {}}
              onPreviewImage={setPreviewImage}
              onOpenDocument={(document) => {
                void openPdfAttachment(document, apiBase).catch(
                  (error: unknown) =>
                    setAttachmentError(
                      error instanceof Error
                        ? error.message
                        : "Could not open PDF.",
                    ),
                )
              }}
            />
          ) : null}
          {tab.excerpts.length > 0 ||
          inputContentAttachments(inputContent(tab.draft)).length > 0 ? (
            <p>
              {tab.excerpts.length} context excerpt
              {tab.excerpts.length === 1 ? "" : "s"} and{" "}
              {inputContentAttachments(inputContent(tab.draft)).length}{" "}
              attachment
              {inputContentAttachments(inputContent(tab.draft)).length === 1
                ? ""
                : "s"}{" "}
              remain in this side chat.
            </p>
          ) : null}
          <div className="side-chat-expired-actions">
            {chat?.activeTurnId ? (
              <button
                type="button"
                disabled={stopping}
                onClick={() => void cancel()}
              >
                {stopping ? "Stopping…" : "Stop response"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                useWorkspaceStore
                  .getState()
                  .addTab("chat", sourceSessionId.current)
              }
            >
              Start new side chat
            </button>
          </div>
        </div>
      ) : (
        <ComposerSurface
          sessionId={tab.id}
          editorKey={tab.id}
          draft={tab.draft}
          excerpts={tab.excerpts}
          sessionSkills={sessionSkills}
          apiBase={apiBase}
          focusRevision={active ? (tab.composerFocusRevision ?? 0) + 1 : 0}
          sending={pending}
          busy={chat?.activeTurnId !== undefined}
          activeTurnId={chat?.activeTurnId}
          stopping={stopping}
          supportsImages={
            modelEntry === undefined ||
            (modelEntry.inputModalities?.includes("image") ?? false)
          }
          supportsOriginal={
            modelEntry === undefined ||
            (modelEntry.imageDetailModes?.includes("original") ?? false)
          }
          historyParts={
            chat?.messages.flatMap((message) =>
              message.role === "user" ? [message.content] : [],
            ) ?? []
          }
          setPromptDraft={(draft) => updateDraft(tab.id, draft, tab.excerpts)}
          removePromptExcerpt={(id) =>
            updateDraft(
              tab.id,
              tab.draft,
              tab.excerpts.filter((entry) => entry.id !== id),
            )
          }
          updatePromptExcerpt={(excerpt) =>
            updateDraft(
              tab.id,
              tab.draft,
              tab.excerpts.map((entry) =>
                entry.id === excerpt.id ? excerpt : entry,
              ),
            )
          }
          onSubmit={(parts) => void send(parts)}
          onCancel={() => void cancel()}
          importAttachments={importAttachments}
          readingAttachments={readingAttachments}
          attachmentError={attachmentError}
          onAttachmentError={setAttachmentError}
          label="Message side chat"
          sendLabel="Send side chat message"
          stopLabel="Stop side chat"
          className="side-chat-composer"
          allowCommands={false}
          modelControls={
            <ModelSelector
              selection={selection}
              onChange={(next) => {
                const state = useAppStore.getState()
                setSelection(
                  next ??
                    normalizeKimiModelSelection(
                      resolveEffectiveModel({
                        sessionCurrent: undefined,
                        userPreference: state.userPreference,
                        defaultProvider: state.defaultProvider,
                        defaultModel: state.defaultModel,
                        providers: state.providers,
                      }),
                      state.providers,
                    ) ??
                    chatRef.current?.modelSelection,
                )
              }}
            />
          }
        />
      )}
      {previewImage ? (
        <ImageLightbox
          src={attachmentUrl(previewImage, apiBase)}
          name={previewImage.name}
          onClose={() => setPreviewImage(undefined)}
        />
      ) : null}
    </div>
  )
}
