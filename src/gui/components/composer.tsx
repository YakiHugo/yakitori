import { ArrowUp, ImagePlus, LoaderCircle, Plus, Square, X } from "lucide-react"
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react"
import { COMPACT_DIRECTIVE, type ImageAttachment } from "../../kernel/events.ts"
import {
  appendImageFiles,
  appendPickedImages,
  discardDraftImages,
  discardPickedImages,
  imageAttachmentUrl,
  requireDesktopBridge,
  pickImages as selectImages,
  validateImageFiles,
} from "../composer-attachments.ts"
import { ConversationScrollContext } from "../hooks/conversation-scroll-context.ts"
import {
  normalizeKimiModelSelection,
  resolveEffectiveModel,
  useAppStore,
  useExecutionView,
} from "../store/app-store.ts"
import {
  type ComposerSuggestion,
  ComposerSuggestions,
} from "./composer-suggestions.tsx"
import { ImageLightbox } from "./image-lightbox.tsx"
import { ModelSelector } from "./model-selector.tsx"
import { skillMentionText } from "./prompt-document.ts"
import { PromptEditor, type PromptEditorHandle } from "./prompt-editor.tsx"
import { Button } from "./ui/button.tsx"

type SlashCommand = Readonly<{
  name: string
  description: string
}>

const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: COMPACT_DIRECTIVE,
    description: "Compact the conversation context",
  },
]

export function Composer() {
  const conversationScroll = useContext(ConversationScrollContext)
  const draft = useAppStore((state) => state.promptDraft) ?? ""
  const attachments = useAppStore((state) => state.promptAttachments)
  const sessionSkillsError = useAppStore((state) => state.sessionSkillsError)
  const sessionSkills = useAppStore((state) => state.sessionSkills)
  const apiBase = useAppStore((state) => state.apiBase)
  const busy = useAppStore((state) => state.busy)
  const focusRevision = useAppStore((state) => state.composerFocusRevision)
  const restoringModelSelectionFor = useAppStore(
    (state) => state.restoringModelSelectionFor,
  )
  const providers = useAppStore((state) => state.providers)
  const defaultProvider = useAppStore((state) => state.defaultProvider)
  const defaultModel = useAppStore((state) => state.defaultModel)
  const userPreference = useAppStore((state) => state.userPreference)
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const sessionCurrent = useAppStore((state) =>
    state.selection.sessionId === undefined
      ? state.draftModelSelection
      : state.modelSelections[state.selection.sessionId],
  )
  const setPromptDraft = useAppStore((state) => state.setPromptDraft)
  const setPromptAttachments = useAppStore(
    (state) => state.setPromptAttachments,
  )
  const admitInput = useAppStore((state) => state.admitInput)
  const cancelTurn = useAppStore((state) => state.cancelTurn)
  const view = useExecutionView()
  const editorRef = useRef<PromptEditorHandle | null>(null)
  const [attachmentError, setAttachmentError] = useState<string>()
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const [previewIndex, setPreviewIndex] = useState<number>()
  const [readingImages, setReadingImages] = useState(false)
  const [historyNavigation, setHistoryNavigation] = useState<{
    readonly sessionId: string | undefined
    readonly stepsBack: number
    readonly savedDraft: string
  }>()
  const [dismissedQuery, setDismissedQuery] = useState<string>()
  const [highlight, setHighlight] = useState<{ query: string; index: number }>()
  const [cursor, setCursor] = useState(draft.length)
  const [hasSelection, setHasSelection] = useState(false)

  const effectiveModel = normalizeKimiModelSelection(
    resolveEffectiveModel({
      sessionCurrent,
      userPreference,
      defaultProvider,
      defaultModel,
      providers,
    }),
    providers,
  )
  const modelEntry = providers
    .find((provider) => provider.name === effectiveModel?.provider)
    ?.models.find((model) => model.id === effectiveModel?.model)
  const supportsImages =
    modelEntry === undefined
      ? true
      : (modelEntry.inputModalities?.includes("image") ?? false)
  const supportsOriginal =
    modelEntry === undefined
      ? true
      : (modelEntry.imageDetailModes?.includes("original") ?? false)

  useLayoutEffect(() => {
    if (focusRevision > 0) editorRef.current?.focus()
  }, [focusRevision])

  useEffect(() => {
    if (!attachmentMenuOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAttachmentMenuOpen(false)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [attachmentMenuOpen])

  // Navigation parked for another session must not leak into this one.
  const activeHistoryNavigation =
    historyNavigation?.sessionId === sessionId ? historyNavigation : undefined

  const historyTexts = view.entries.flatMap((entry) =>
    entry.kind === "user_input" ? [entry.text] : [],
  )

  const prefix = draft.slice(0, cursor)
  const token = /(?:^|\s)([/$])([\p{L}\p{N}_:-]*)$/u.exec(prefix)
  const query = token?.[2] ?? ""
  const trigger = token?.[1]
  const tokenStart = cursor - query.length - 1
  const tokenEnd =
    cursor + (/^[\p{L}\p{N}_:-]*/u.exec(draft.slice(cursor))?.[0].length ?? 0)
  const queryKey = `${sessionId}:${tokenStart}:${trigger}:${query}`
  const matchingSkills: ComposerSuggestion[] = [...sessionSkills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(
      (skill) =>
        !draft.includes(skillMentionText(skill)) &&
        `${skill.name} ${skill.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .map((skill) => ({
      kind: "skill",
      name: skill.name,
      description: skill.description,
      skill,
    }))
  const suggestions: ComposerSuggestion[] = [
    ...(trigger === "/" &&
    tokenStart === 0 &&
    draft.slice(tokenEnd).trim().length === 0
      ? SLASH_COMMANDS.filter((command) =>
          command.name.slice(1).toLowerCase().startsWith(query.toLowerCase()),
        ).map((command) => ({ ...command, kind: "command" as const }))
      : []),
    ...matchingSkills,
  ]
  const menuOpen =
    token !== null && !hasSelection && dismissedQuery !== queryKey
  const activeHighlight =
    highlight?.query === queryKey
      ? Math.min(highlight.index, suggestions.length - 1)
      : 0

  const text = draft.trim()
  const sending =
    sessionId !== undefined && inFlightActions.has(`admit:${sessionId}`)
  const activeTurnId = view.activeTurnId
  const stopping =
    activeTurnId !== undefined && inFlightActions.has(`cancel:${activeTurnId}`)
  const previewAttachment =
    previewIndex === undefined ? undefined : attachments[previewIndex]
  const containsInput = text.length > 0 || attachments.length > 0
  const compactBlocked = text === COMPACT_DIRECTIVE && attachments.length > 0
  const canSend =
    containsInput &&
    (sessionId === undefined || restoringModelSelectionFor !== sessionId) &&
    !busy &&
    !sending &&
    !readingImages &&
    !compactBlocked

  const importImages = async (
    prepare: () => Promise<
      | {
          readonly collect: (
            sessionId: string,
          ) => Promise<readonly ImageAttachment[]>
          readonly cleanup?: (() => Promise<void>) | undefined
        }
      | undefined
    >,
    validate?: () => void,
  ) => {
    if (readingImages) return
    setReadingImages(true)
    setAttachmentError(undefined)
    let importSessionId = sessionId
    const importIntentRevision =
      useAppStore.getState().sessionSelectionIntentRevision
    let importSelectionRevision = importIntentRevision
    let createdSessionId: string | undefined
    let draftBeforeCreate: string | undefined
    let cleanup: (() => Promise<void>) | undefined
    try {
      // Reject unusable files before a lazy createSession can litter an
      // empty session.
      validate?.()
      requireDesktopBridge()
      const prepared = await prepare()
      if (prepared === undefined) return
      cleanup = prepared.cleanup
      if (importSessionId === undefined) {
        let current = useAppStore.getState()
        if (current.sessionSelectionIntentRevision !== importIntentRevision)
          return
        importSessionId = current.selection.sessionId
        if (
          importSessionId === undefined &&
          current.inFlightActions.has("create-session")
        ) {
          await waitForAction("create-session")
          current = useAppStore.getState()
          if (current.sessionSelectionIntentRevision !== importIntentRevision)
            return
          importSessionId = current.selection.sessionId
        }
      }
      if (importSessionId === undefined) {
        draftBeforeCreate = useAppStore.getState().promptDraft
        importSessionId = await useAppStore.getState().createSession()
        if (importSessionId === undefined) return
        createdSessionId = importSessionId
        importSelectionRevision =
          useAppStore.getState().sessionSelectionIntentRevision
      }
      const next = await prepared.collect(importSessionId)
      const current = useAppStore.getState()
      if (
        current.selection.sessionId !== importSessionId ||
        current.sessionSelectionIntentRevision !== importSelectionRevision
      ) {
        await discardDraftImages(next.slice(attachments.length))
        return
      }
      setPromptAttachments(next)
    } catch (error) {
      const current = useAppStore.getState()
      const stillSelected =
        current.selection.sessionId === importSessionId &&
        current.sessionSelectionIntentRevision === importSelectionRevision
      if (createdSessionId !== undefined && stillSelected) {
        await current.deleteSession(createdSessionId)
        if (draftBeforeCreate !== undefined) {
          useAppStore.getState().setPromptDraft(draftBeforeCreate)
        }
      }
      if (stillSelected || createdSessionId !== undefined) {
        setAttachmentError(
          error instanceof Error
            ? error.message
            : "Images could not be attached.",
        )
      }
    } finally {
      if (cleanup !== undefined) {
        try {
          await cleanup()
        } catch (error) {
          setAttachmentError(
            error instanceof Error
              ? error.message
              : "Image selection could not be released.",
          )
        }
      }
      setReadingImages(false)
    }
  }

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) return
    await importImages(
      async () => ({
        collect: (importSessionId) =>
          appendImageFiles(attachments, importSessionId, files),
      }),
      () => validateImageFiles(files),
    )
  }

  const pickImages = async () => {
    setAttachmentMenuOpen(false)
    await importImages(async () => {
      const selection = await selectImages()
      if (selection === undefined) return
      return {
        collect: (importSessionId: string) =>
          appendPickedImages(
            attachments,
            importSessionId,
            selection.selectionId,
          ),
        cleanup: () => discardPickedImages(selection.selectionId),
      }
    })
  }

  const submit = () => {
    if (!canSend) return
    conversationScroll?.jumpToBottom()
    setHistoryNavigation(undefined)
    if (attachments.length === 0) void admitInput(text)
    else
      void admitInput(
        text,
        supportsOriginal
          ? attachments
          : attachments.map((attachment) => ({
              ...attachment,
              detail: "high" as const,
            })),
      )
  }

  // Selecting a command dispatches it right away, like codex: the draft
  // clears and the command runs. When execution is currently blocked —
  // mid-restore, busy, or compact with staged images, which the compact lane
  // rejects — the selection only completes the text so nothing is lost.
  const runSlashCommand = (command: SlashCommand): void => {
    setDismissedQuery(queryKey)
    setHighlight(undefined)
    const blocked =
      sessionId === undefined ||
      restoringModelSelectionFor === sessionId ||
      busy ||
      sending ||
      (command.name === COMPACT_DIRECTIVE && attachments.length > 0)
    if (blocked) {
      setPromptDraft(command.name)
      editorRef.current?.focus()
      return
    }
    setPromptDraft("")
    conversationScroll?.jumpToBottom()
    void admitInput(command.name)
  }

  const pickSuggestion = (item: ComposerSuggestion): void => {
    setDismissedQuery(queryKey)
    setHighlight(undefined)
    if (item.kind === "command") runSlashCommand(item)
    else
      editorRef.current?.replaceRange(
        tokenStart,
        tokenEnd,
        `${skillMentionText(item.skill)} `,
      )
    editorRef.current?.focus()
  }

  const handleDraftKeyDown = (event: globalThis.KeyboardEvent): boolean => {
    if (event.isComposing) return false
    if (menuOpen) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        setDismissedQuery(queryKey)
        return true
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        if (suggestions.length > 0)
          setHighlight({
            query: queryKey,
            index:
              (activeHighlight +
                (event.key === "ArrowDown" ? 1 : -1) +
                suggestions.length) %
              suggestions.length,
          })
        return true
      }
      const item = suggestions[activeHighlight]
      if (
        item &&
        ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab")
      ) {
        event.preventDefault()
        pickSuggestion(item)
        return true
      }
    }
    if (event.key === "ArrowUp") {
      const cursorAtStart = cursor === 0 && !hasSelection
      if (activeHistoryNavigation === undefined && !cursorAtStart) return false
      event.preventDefault()
      const stepsBack = (activeHistoryNavigation?.stepsBack ?? 0) + 1
      const entry = historyTexts[historyTexts.length - stepsBack]
      if (entry === undefined) return false
      setHistoryNavigation({
        sessionId,
        stepsBack,
        savedDraft: activeHistoryNavigation?.savedDraft ?? draft,
      })
      setPromptDraft(entry)
      return true
    }
    if (event.key === "ArrowDown" && activeHistoryNavigation !== undefined) {
      event.preventDefault()
      const stepsBack = activeHistoryNavigation.stepsBack - 1
      if (stepsBack === 0) {
        setPromptDraft(activeHistoryNavigation.savedDraft)
        setHistoryNavigation(undefined)
        return true
      }
      const entry = historyTexts[historyTexts.length - stepsBack]
      if (entry === undefined) return false
      setHistoryNavigation({ ...activeHistoryNavigation, stepsBack })
      setPromptDraft(entry)
      return true
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
      return true
    }
    return false
  }

  return (
    <footer className="conversation-composer-footer pt-3 pb-3">
      <form
        className="conversation-composer mx-auto w-full"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault()
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          void addFiles(Array.from(event.dataTransfer.files))
        }}
      >
        <div className="relative overflow-visible rounded-[18px] border bg-card shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_7%,transparent),0_8px_24px_-10px_color-mix(in_oklab,var(--foreground)_14%,transparent)] transition-shadow focus-within:shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_8%,transparent),0_10px_30px_-10px_color-mix(in_oklab,var(--foreground)_20%,transparent)]">
          <ComposerSuggestions
            open={menuOpen}
            items={suggestions}
            activeIndex={activeHighlight}
            skillOnly={trigger === "$"}
            error={sessionSkillsError}
            onHighlight={(index) => setHighlight({ query: queryKey, index })}
            onPick={pickSuggestion}
          />
          {attachments.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto px-4 pt-3">
              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.file.rolloutId}:${attachment.file.path}`}
                  className="group/image relative size-14 shrink-0 rounded-xl border bg-muted shadow-sm"
                >
                  <button
                    type="button"
                    aria-label={`Preview ${attachment.name}`}
                    onClick={() => setPreviewIndex(index)}
                    className="block size-full cursor-zoom-in overflow-hidden rounded-[calc(var(--radius-xl)-1px)]"
                  >
                    <img
                      src={imageAttachmentUrl(attachment, apiBase)}
                      alt={attachment.name}
                      className="size-full object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    disabled={sending}
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => {
                      setPromptAttachments(
                        attachments.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      )
                      void discardDraftImages([attachment]).catch((error) => {
                        setAttachmentError(
                          error instanceof Error
                            ? error.message
                            : "Image could not be removed.",
                        )
                      })
                    }}
                    className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-white/80 bg-black/75 text-white shadow-sm transition-[transform,background-color] hover:scale-105 hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={
                      supportsOriginal
                        ? `Use ${attachment.detail === "original" ? "high" : "original"} detail for ${attachment.name}`
                        : `Original detail unavailable for ${attachment.name}`
                    }
                    disabled={!supportsOriginal || sending}
                    onClick={() =>
                      setPromptAttachments(
                        attachments.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? {
                                ...candidate,
                                detail:
                                  candidate.detail === "original"
                                    ? "high"
                                    : "original",
                              }
                            : candidate,
                        ),
                      )
                    }
                    title={
                      supportsOriginal
                        ? "Toggle image detail"
                        : "Original detail unavailable"
                    }
                    className="absolute bottom-1 left-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[9px] leading-none font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 hover:bg-black focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {supportsOriginal && attachment.detail === "original"
                      ? "Original"
                      : "High"}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {attachments.length > 0 && !supportsImages ? (
            <p className="px-3 pt-2 text-xs text-amber-700 dark:text-amber-300">
              The selected model does not support images. Attachments will be
              omitted and the model will receive a notice.
            </p>
          ) : attachments.length > 0 && !supportsOriginal ? (
            <p className="px-3 pt-2 text-xs text-muted-foreground">
              Original detail is unavailable for the selected model. Images will
              use High detail.
            </p>
          ) : null}

          <PromptEditor
            key={sessionId}
            ref={editorRef}
            label="Message the Mate"
            value={draft}
            placeholder={
              sessionId === undefined
                ? "Describe what you want to work on"
                : "Ask anything"
            }
            disabled={sending}
            onChange={(text) => {
              setDismissedQuery(undefined)
              setHistoryNavigation(undefined)
              setPromptDraft(text)
            }}
            onSelection={(from, to) => {
              setCursor(from)
              setHasSelection(from !== to)
            }}
            menuOpen={menuOpen}
            activeSuggestion={
              menuOpen && suggestions.length > 0
                ? `composer-suggestion-${activeHighlight}`
                : undefined
            }
            onBlur={() => setDismissedQuery(queryKey)}
            onFocus={() => setDismissedQuery(undefined)}
            onPasteImages={(images) => void addFiles(images)}
            onKeyDown={handleDraftKeyDown}
          />

          <div className="flex min-h-12 items-center justify-between gap-3 px-2.5 pb-2.5">
            <div className="relative flex min-w-0 items-center gap-1">
              {attachmentMenuOpen ? (
                <div
                  aria-hidden="true"
                  className="fixed inset-0 z-10"
                  onClick={() => setAttachmentMenuOpen(false)}
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={readingImages}
                aria-label="Add attachment"
                aria-expanded={attachmentMenuOpen}
                title="Add attachment"
                className={`relative rounded-full text-muted-foreground hover:text-foreground ${attachmentMenuOpen ? "z-20" : ""}`}
                onClick={() => setAttachmentMenuOpen((open) => !open)}
              >
                {readingImages ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plus
                    className={`transition-transform duration-150 ${attachmentMenuOpen ? "rotate-45" : ""}`}
                  />
                )}
              </Button>
              {attachmentMenuOpen ? (
                <div className="composer-control-popover absolute bottom-full left-0 z-20 mb-2 w-56 rounded-xl border bg-popover p-1.5 shadow-[0_12px_32px_-12px_color-mix(in_oklab,var(--foreground)_22%,transparent),0_3px_8px_-5px_color-mix(in_oklab,var(--foreground)_15%,transparent)]">
                  <button
                    type="button"
                    aria-label="Upload image"
                    onClick={() => void pickImages()}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                      <ImagePlus className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        Upload image
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        PNG, JPEG, GIF, or WebP
                      </span>
                    </span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <ModelSelector />
              {activeTurnId === undefined ? (
                <Button
                  type="submit"
                  size="icon-sm"
                  disabled={!canSend}
                  aria-label={sending ? "Sending" : "Send"}
                  title={
                    compactBlocked
                      ? "Remove images before compacting"
                      : "Send message"
                  }
                  className="rounded-full"
                >
                  {sending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <ArrowUp />
                  )}
                  <span className="sr-only">
                    {sending ? "Sending" : "Send"}
                  </span>
                </Button>
              ) : (
                // A stop action, not a submit: Enter in the editor still
                // queues a follow-up through the unchanged submit path.
                <Button
                  type="button"
                  size="icon-sm"
                  disabled={stopping}
                  aria-label={stopping ? "Stopping" : "Interrupt"}
                  title={stopping ? "Stopping" : "Interrupt"}
                  className="rounded-full"
                  onClick={() => void cancelTurn(activeTurnId)}
                >
                  {stopping ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Square />
                  )}
                  <span className="sr-only">
                    {stopping ? "Stopping" : "Interrupt"}
                  </span>
                </Button>
              )}
            </div>
          </div>
        </div>

        {attachmentError === undefined ? null : (
          <p role="alert" className="mt-1.5 px-3 text-xs text-destructive">
            {attachmentError}
          </p>
        )}
      </form>
      {previewAttachment === undefined ? null : (
        <ImageLightbox
          src={imageAttachmentUrl(previewAttachment, apiBase)}
          name={previewAttachment.name}
          onClose={() => setPreviewIndex(undefined)}
        />
      )}
    </footer>
  )
}

function waitForAction(key: string): Promise<void> {
  if (!useAppStore.getState().inFlightActions.has(key)) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.inFlightActions.has(key)) return
      unsubscribe()
      resolve()
    })
  })
}
