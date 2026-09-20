import { LoaderCircle, MessageCirclePlus } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ImageAttachment, ModelSelection } from "../../kernel/events.ts"
import type { ContextExcerpt } from "../../kernel/input-context.ts"
import type { SideChatSnapshot } from "../../server/side-chat.ts"
import {
  discardDraftImages,
  imageAttachmentUrl,
  requireDesktopBridge,
} from "../composer-attachments.ts"
import { contextSourceAttributes } from "../conversation-context.ts"
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
  type ComposerImageImport,
  ComposerSurface,
} from "./composer-surface.tsx"
import { ImageLightbox } from "./image-lightbox.tsx"
import { MarkdownView } from "./markdown.tsx"
import { ModelSelector } from "./model-selector.tsx"
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
  const [readingImages, setReadingImages] = useState(false)
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
        text: string
        contextAttachments: readonly ContextExcerpt[]
        attachments: readonly ImageAttachment[]
        requestId: string
        modelSelection: ModelSelection | undefined
      }
    | undefined
  >(undefined)
  const client = getAppRpcClient(apiBase)
  const updateDraft = useWorkspaceStore((state) => state.updateChatDraft)
  const updateStatus = useWorkspaceStore((state) => state.updateChatStatus)
  const latestTab = () => {
    const state = useWorkspaceStore.getState()
    const current = state.tabs.find((entry) => entry.id === tab.id)
    return current?.kind === "chat" ? current : undefined
  }

  const applySnapshot = useCallback((next: SideChatSnapshot) => {
    if (disposed.current) return
    if (chatRef.current && next.revision < chatRef.current.revision) return
    chatRef.current = next
    setChat(next)
  }, [])
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
    const currentError = error ?? chat?.error
    updateStatus(tab.id, {
      hasMessages: (chat?.messages.length ?? 0) > 0,
      ...(chat?.activeTurnId ? { activeTurnId: chat.activeTurnId } : {}),
      ...(currentError === undefined ? {} : { error: currentError }),
    })
  }, [
    tab.id,
    chat?.messages.length,
    chat?.activeTurnId,
    chat?.error,
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

  const importImages: ComposerImageImport = async (prepare, validate) => {
    if (readingImages || sending.current) return
    setReadingImages(true)
    setAttachmentError(undefined)
    let release: (() => Promise<void>) | undefined
    try {
      validate?.()
      requireDesktopBridge()
      const prepared = await prepare()
      if (!prepared) return
      release = prepared.cleanup
      const current = await ensureChat()
      if (!current) return
      const images = await prepared.collect(current.id)
      const latest = latestTab()
      const added = images.slice(tab.attachments.length)
      if (disposed.current || !latest) {
        await discardDraftImages(added)
        return
      }
      updateDraft(tab.id, latest.draft, latest.excerpts, [
        ...latest.attachments,
        ...added,
      ])
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
      if (!disposed.current) setReadingImages(false)
    }
  }

  const send = async (text = tab.draft.trim(), images = tab.attachments) => {
    if (
      sending.current ||
      chatRef.current?.activeTurnId ||
      (!text && tab.excerpts.length === 0 && images.length === 0)
    )
      return
    const originalDraft = tab.draft
    const originalExcerpts = tab.excerpts
    const originalAttachments = tab.attachments
    const modelSelection = selection ?? chatRef.current?.modelSelection
    const payload = {
      text,
      contextAttachments: originalExcerpts,
      attachments: images,
      modelSelection,
    }
    const request =
      attempt.current &&
      JSON.stringify({
        text: attempt.current.text,
        contextAttachments: attempt.current.contextAttachments,
        attachments: attempt.current.attachments,
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
      applySnapshot(response)
      const latest = latestTab()
      // An ACK only consumes the exact draft that was submitted. Selection
      // actions and uploads may have staged new input while it was in flight.
      if (
        latest?.draft === originalDraft &&
        latest.excerpts === originalExcerpts &&
        latest.attachments === originalAttachments
      )
        updateDraft(tab.id, "", [], [])
      attempt.current = undefined
    } catch (cause) {
      if (!disposed.current)
        setError(cause instanceof Error ? cause.message : String(cause))
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
    <div className="side-chat-panel">
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
              {message.contextAttachments?.length ? (
                <ContextExcerptChips excerpts={message.contextAttachments} />
              ) : null}
              {message.attachments?.length ? (
                <div className="flex flex-wrap gap-2 pb-2">
                  {message.attachments.map((image) => (
                    <button
                      type="button"
                      key={`${image.file.rolloutId}:${image.file.path}`}
                      aria-label={`Preview ${image.name}`}
                      onClick={() => setPreviewImage(image)}
                      className="cursor-zoom-in"
                    >
                      <img
                        src={imageAttachmentUrl(image, apiBase)}
                        alt={image.name}
                        className="max-h-40 rounded-lg object-contain"
                      />
                    </button>
                  ))}
                </div>
              ) : null}
              <MarkdownView text={message.text} workspaceRoot={chat.cwd} />
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
      <ComposerSurface
        sessionId={tab.id}
        draft={tab.draft}
        excerpts={tab.excerpts}
        attachments={tab.attachments}
        sessionSkills={sessionSkills}
        apiBase={apiBase}
        focusRevision={active ? tab.excerpts.length + 1 : 0}
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
        historyTexts={
          chat?.messages.flatMap((message) =>
            message.role === "user" ? [message.text] : [],
          ) ?? []
        }
        setPromptDraft={(draft) => updateDraft(tab.id, draft, tab.excerpts)}
        setPromptAttachments={(images) =>
          updateDraft(tab.id, tab.draft, tab.excerpts, images)
        }
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
        onSubmit={(text, images) => void send(text, images)}
        onCancel={() => void cancel()}
        importImages={importImages}
        readingImages={readingImages}
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
      {previewImage ? (
        <ImageLightbox
          src={imageAttachmentUrl(previewImage, apiBase)}
          name={previewImage.name}
          onClose={() => setPreviewImage(undefined)}
        />
      ) : null}
    </div>
  )
}
