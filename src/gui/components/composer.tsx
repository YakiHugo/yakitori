import { ArrowUp, LoaderCircle, Plus, ShieldCheck, X } from "lucide-react"
import {
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { COMPACT_DIRECTIVE } from "../../kernel/events.ts"
import {
  appendImageFiles,
  appendPickedImages,
  discardDraftImages,
  imageAttachmentUrl,
} from "../composer-attachments.ts"
import {
  normalizeKimiModelSelection,
  resolveEffectiveModel,
  useAppStore,
  useExecutionView,
} from "../store/app-store.ts"
import { ModelSelector } from "./model-selector.tsx"
import { Button } from "./ui/button.tsx"

type SlashCommand = {
  readonly name: string
  readonly description: string
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: COMPACT_DIRECTIVE,
    description: "Compact the conversation context",
  },
]

export function Composer() {
  const draft = useAppStore((state) => state.promptDraft) ?? ""
  const attachments = useAppStore((state) => state.promptAttachments)
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
  const sessionSelectionIntentRevision = useAppStore(
    (state) => state.sessionSelectionIntentRevision,
  )
  const sessionCurrent = useAppStore((state) =>
    state.selection.sessionId === undefined
      ? undefined
      : state.modelSelections[state.selection.sessionId],
  )
  const setPromptDraft = useAppStore((state) => state.setPromptDraft)
  const setPromptAttachments = useAppStore(
    (state) => state.setPromptAttachments,
  )
  const admitInput = useAppStore((state) => state.admitInput)
  const view = useExecutionView()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [attachmentError, setAttachmentError] = useState<string>()
  const [readingImages, setReadingImages] = useState(false)
  const [historyNavigation, setHistoryNavigation] = useState<{
    readonly sessionId: string | undefined
    readonly stepsBack: number
    readonly savedDraft: string
  }>()
  const [slashDismissed, setSlashDismissed] = useState<string>()

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
    if (focusRevision > 0) textareaRef.current?.focus()
  }, [focusRevision])

  // Navigation parked for another session must not leak into this one.
  const activeHistoryNavigation =
    historyNavigation?.sessionId === sessionId ? historyNavigation : undefined

  const historyTexts = view.entries.flatMap((entry) =>
    entry.kind === "user_input" ? [entry.text] : [],
  )

  // The menu tracks a single first-token query like codex's command popup:
  // it stays open while the draft is exactly one `/name` token.
  const slashQuery =
    draft.startsWith("/") && !/\s/.test(draft) ? draft : undefined
  const slashMatches =
    slashQuery === undefined || slashDismissed === slashQuery
      ? []
      : SLASH_COMMANDS.filter(
          (command) =>
            command.name.startsWith(slashQuery) && command.name !== slashQuery,
        )
  const slashMenuOpen = slashMatches.length > 0

  const text = draft.trim()
  const sending =
    sessionId !== undefined && inFlightActions.has(`admit:${sessionId}`)
  const containsInput = text.length > 0 || attachments.length > 0
  const compactHasAttachments =
    text === COMPACT_DIRECTIVE && attachments.length > 0
  const canSend =
    containsInput &&
    sessionId !== undefined &&
    restoringModelSelectionFor !== sessionId &&
    !busy &&
    !sending &&
    !readingImages &&
    !compactHasAttachments

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0 || sessionId === undefined) return
    const importSessionId = sessionId
    const importSelectionRevision = sessionSelectionIntentRevision
    setReadingImages(true)
    setAttachmentError(undefined)
    try {
      const next = await appendImageFiles(attachments, importSessionId, files)
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
      if (
        current.selection.sessionId === importSessionId &&
        current.sessionSelectionIntentRevision === importSelectionRevision
      ) {
        setAttachmentError(
          error instanceof Error
            ? error.message
            : "Images could not be attached.",
        )
      }
    } finally {
      setReadingImages(false)
    }
  }

  const pickImages = async () => {
    if (sessionId === undefined) return
    const importSessionId = sessionId
    const importSelectionRevision = sessionSelectionIntentRevision
    setReadingImages(true)
    setAttachmentError(undefined)
    try {
      const next = await appendPickedImages(attachments, importSessionId)
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
      if (
        current.selection.sessionId === importSessionId &&
        current.sessionSelectionIntentRevision === importSelectionRevision
      ) {
        setAttachmentError(
          error instanceof Error
            ? error.message
            : "Images could not be attached.",
        )
      }
    } finally {
      setReadingImages(false)
    }
  }

  const submit = () => {
    if (!canSend) return
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

  const acceptSlashCommand = (command: SlashCommand): void => {
    setSlashDismissed(undefined)
    setPromptDraft(command.name)
    textareaRef.current?.focus()
  }

  const handleDraftKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.nativeEvent.isComposing) return
    if (slashMenuOpen) {
      if (event.key === "Escape") {
        setSlashDismissed(slashQuery)
        return
      }
      const first = slashMatches[0]
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        first !== undefined
      ) {
        event.preventDefault()
        acceptSlashCommand(first)
        return
      }
    }
    if (event.key === "ArrowUp") {
      const cursorAtStart =
        event.currentTarget.selectionStart === 0 &&
        event.currentTarget.selectionEnd === 0
      if (activeHistoryNavigation === undefined && !cursorAtStart) return
      event.preventDefault()
      const stepsBack = (activeHistoryNavigation?.stepsBack ?? 0) + 1
      const entry = historyTexts[historyTexts.length - stepsBack]
      if (entry === undefined) return
      setHistoryNavigation({
        sessionId,
        stepsBack,
        savedDraft: activeHistoryNavigation?.savedDraft ?? draft,
      })
      setPromptDraft(entry)
      return
    }
    if (event.key === "ArrowDown" && activeHistoryNavigation !== undefined) {
      event.preventDefault()
      const stepsBack = activeHistoryNavigation.stepsBack - 1
      if (stepsBack === 0) {
        setPromptDraft(activeHistoryNavigation.savedDraft)
        setHistoryNavigation(undefined)
        return
      }
      const entry = historyTexts[historyTexts.length - stepsBack]
      if (entry === undefined) return
      setHistoryNavigation({ ...activeHistoryNavigation, stepsBack })
      setPromptDraft(entry)
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <footer className="bg-background/95 px-4 pt-3 pb-2 backdrop-blur-sm">
      <form
        className="mx-auto max-w-3xl"
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
        <div className="relative overflow-visible rounded-2xl border bg-card shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_7%,transparent),0_8px_24px_-10px_color-mix(in_oklab,var(--foreground)_14%,transparent)] transition-shadow focus-within:shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_8%,transparent),0_10px_30px_-10px_color-mix(in_oklab,var(--foreground)_20%,transparent)]">
          {slashMenuOpen ? (
            <div
              role="listbox"
              aria-label="Slash commands"
              className="absolute bottom-full left-0 z-10 mb-1 w-72 space-y-1 rounded-md border bg-popover p-2 text-sm shadow-md"
            >
              {slashMatches.map((command, index) => (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-selected={index === 0}
                  onClick={() => acceptSlashCommand(command)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent ${index === 0 ? "bg-accent" : ""}`}
                >
                  <span className="shrink-0 font-mono">{command.name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {command.description}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto px-3 pt-3">
              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.file.rolloutId}:${attachment.file.path}`}
                  className="group/image relative size-18 shrink-0 overflow-hidden rounded-xl border bg-muted"
                >
                  <img
                    src={imageAttachmentUrl(attachment, apiBase)}
                    alt={attachment.name}
                    className="size-full object-cover"
                  />
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
                    className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/65 text-white opacity-90 transition-opacity hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
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
                    className="absolute top-1 left-1 rounded bg-black/65 px-1 py-0.5 text-[9px] font-medium text-white transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {supportsOriginal && attachment.detail === "original"
                      ? "Original"
                      : "High"}
                  </button>
                  <span className="absolute right-1 bottom-1 left-1 truncate rounded bg-black/55 px-1 py-0.5 text-[9px] text-white opacity-0 transition-opacity group-hover/image:opacity-100">
                    {attachment.name}
                  </span>
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

          <textarea
            ref={textareaRef}
            aria-label="Message the Mate"
            value={draft}
            rows={1}
            placeholder={
              sessionId === undefined
                ? "Create or select a session to start"
                : "Message the Mate"
            }
            disabled={sessionId === undefined}
            onChange={(event) => {
              setHistoryNavigation(undefined)
              setPromptDraft(event.currentTarget.value)
            }}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              )
              if (images.length === 0) return
              event.preventDefault()
              void addFiles(images)
            }}
            onKeyDown={handleDraftKeyDown}
            className="field-sizing-content max-h-50 min-h-13 w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/65 disabled:opacity-50"
          />

          <div className="flex min-h-12 items-center justify-between gap-3 px-2.5 pb-2.5">
            <div className="flex min-w-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={sessionId === undefined || readingImages}
                aria-label="Attach images"
                title="Attach images"
                className="rounded-full bg-muted/70"
                onClick={() => void pickImages()}
              >
                {readingImages ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plus />
                )}
              </Button>
              <div
                className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground"
                title="YOLO mode: tools run without approval prompts; hard safety bounds still apply."
              >
                <ShieldCheck className="size-4 shrink-0" />
                <span className="truncate">Full access</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <ModelSelector />
              <Button
                type="submit"
                size="icon"
                disabled={!canSend}
                aria-label={sending ? "Sending" : "Send"}
                title={
                  compactHasAttachments
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
                <span className="sr-only">{sending ? "Sending" : "Send"}</span>
              </Button>
            </div>
          </div>
        </div>

        {attachmentError === undefined ? null : (
          <p role="alert" className="mt-1.5 px-3 text-xs text-destructive">
            {attachmentError}
          </p>
        )}
      </form>
    </footer>
  )
}
