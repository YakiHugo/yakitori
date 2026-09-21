import { ArrowUp, ImagePlus, LoaderCircle, Plus, Square, X } from "lucide-react"
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { COMPACT_DIRECTIVE, type ImageAttachment } from "../../kernel/events.ts"
import type { ContextExcerpt } from "../../kernel/input-context.ts"
import type { ApiSkillSummary } from "../../server/protocol.ts"
import { usePreferencesStore } from "../store/preferences-store.ts"
import {
  appendImageFiles,
  appendPickedImages,
  discardDraftImages,
  discardPickedImages,
  imageAttachmentUrl,
  pickImages as selectImages,
  validateImageFiles,
} from "../composer-attachments.ts"
import {
  type ComposerSuggestion,
  ComposerSuggestions,
} from "./composer-suggestions.tsx"
import { ImageLightbox } from "./image-lightbox.tsx"
import { fileMentionText, skillMentionText } from "./prompt-document.ts"
import { PromptEditor, type PromptEditorHandle } from "./prompt-editor.tsx"
import { ContextExcerptChips } from "./selection-actions.tsx"
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

export type ComposerImageImport = (
  prepare: () => Promise<
    | {
        collect(sessionId: string): Promise<readonly ImageAttachment[]>
        cleanup?: (() => Promise<void>) | undefined
      }
    | undefined
  >,
  validate?: () => void,
) => Promise<void>

// Session creation and submission belong to the caller. Editor behavior and
// presentation are shared by the main conversation and temporary chats.
export function ComposerSurface({
  sessionId,
  draft,
  attachments,
  excerpts,
  sessionSkills,
  sessionSkillsError,
  apiBase,
  focusRevision = 0,
  busy = false,
  sending = false,
  stopping = false,
  activeTurnId,
  supportsImages = true,
  supportsOriginal = true,
  historyTexts,
  setPromptDraft,
  setPromptAttachments,
  removePromptExcerpt,
  updatePromptExcerpt,
  onSubmit,
  onCancel,
  modelControls,
  importImages,
  readingImages,
  attachmentError,
  onAttachmentError,
  searchFiles,
  label = "Message the Mate",
  placeholder = "Ask anything",
  className = "conversation-composer-footer pt-3 pb-3",
  allowCommands = true,
  sendLabel = "Send",
  stopLabel = "Interrupt",
}: Readonly<{
  sessionId?: string | undefined
  draft: string
  attachments: readonly ImageAttachment[]
  excerpts: readonly ContextExcerpt[]
  sessionSkills: readonly ApiSkillSummary[]
  sessionSkillsError?: string | undefined
  apiBase: string
  focusRevision?: number
  busy?: boolean
  sending?: boolean
  stopping?: boolean
  activeTurnId?: string | undefined
  supportsImages?: boolean
  supportsOriginal?: boolean
  historyTexts: readonly string[]
  setPromptDraft(text: string): void
  setPromptAttachments(attachments: readonly ImageAttachment[]): void
  removePromptExcerpt(id: string): void
  updatePromptExcerpt(excerpt: ContextExcerpt): void
  onSubmit(text: string, attachments: readonly ImageAttachment[]): void
  onCancel(): void
  modelControls: ReactNode
  importImages: ComposerImageImport
  readingImages: boolean
  attachmentError?: string | undefined
  onAttachmentError(error: string): void
  // Powers the @-mention file picker; without it the @ trigger stays inert.
  searchFiles?: (
    query: string,
  ) => Promise<readonly Readonly<{ name: string; path: string }>[]>
  label?: string
  placeholder?: string
  className?: string
  allowCommands?: boolean
  sendLabel?: string
  stopLabel?: string
}>) {
  const suggestionsId = useId()
  const sendShortcut = usePreferencesStore((state) => state.sendShortcut)
  const editorRef = useRef<PromptEditorHandle | null>(null)
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const [previewIndex, setPreviewIndex] = useState<number>()
  const [historyNavigation, setHistoryNavigation] =
    useState<
      Readonly<{
        sessionId: string | undefined
        stepsBack: number
        savedDraft: string
      }>
    >()
  const [dismissedQuery, setDismissedQuery] = useState<string>()
  const [highlight, setHighlight] = useState<{ query: string; index: number }>()
  const [cursor, setCursor] = useState(draft.length)
  const [hasSelection, setHasSelection] = useState(false)
  const [fileMatches, setFileMatches] = useState<{
    key: string
    items: readonly Readonly<{ name: string; path: string }>[]
  }>()

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

  const prefix = draft.slice(0, cursor)
  const token = /(?:^|\s)([/$@])([\p{L}\p{N}_:./-]*)$/u.exec(prefix)
  const query = token?.[2] ?? ""
  const trigger = token?.[1]
  const tokenStart = cursor - query.length - 1
  const tokenEnd =
    cursor + (/^[\p{L}\p{N}_:./-]*/u.exec(draft.slice(cursor))?.[0].length ?? 0)
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
  const suggestions: ComposerSuggestion[] =
    trigger === "@"
      ? (fileMatches?.key === queryKey ? fileMatches.items : []).map(
          (file) => ({
            kind: "file",
            name: file.name,
            description: file.path,
            file,
          }),
        )
      : [
          ...(allowCommands &&
          trigger === "/" &&
          tokenStart === 0 &&
          draft.slice(tokenEnd).trim().length === 0
            ? SLASH_COMMANDS.filter((command) =>
                command.name
                  .slice(1)
                  .toLowerCase()
                  .startsWith(query.toLowerCase()),
              ).map((command) => ({ ...command, kind: "command" as const }))
            : []),
          ...matchingSkills,
        ]
  const menuOpen =
    token !== null &&
    !hasSelection &&
    dismissedQuery !== queryKey &&
    (trigger !== "@" || searchFiles !== undefined)
  const activeHighlight =
    highlight?.query === queryKey
      ? Math.min(highlight.index, suggestions.length - 1)
      : 0

  useEffect(() => {
    if (trigger !== "@" || searchFiles === undefined || !menuOpen) return
    let current = true
    const timer = setTimeout(() => {
      void searchFiles(query).then(
        (items) => {
          if (current) setFileMatches({ key: queryKey, items })
        },
        () => {
          if (current) setFileMatches({ key: queryKey, items: [] })
        },
      )
    }, 150)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [trigger, query, queryKey, menuOpen, searchFiles])

  const text = draft.trim()
  const previewAttachment =
    previewIndex === undefined ? undefined : attachments[previewIndex]
  const containsInput =
    text.length > 0 || attachments.length > 0 || excerpts.length > 0
  const compactBlocked =
    allowCommands &&
    text === COMPACT_DIRECTIVE &&
    (attachments.length > 0 || excerpts.length > 0)
  const canSend =
    containsInput && !busy && !sending && !readingImages && !compactBlocked

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
    setHistoryNavigation(undefined)
    onSubmit(
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
      busy ||
      sending ||
      (command.name === COMPACT_DIRECTIVE &&
        (attachments.length > 0 || excerpts.length > 0))
    if (blocked) {
      setPromptDraft(command.name)
      editorRef.current?.focus()
      return
    }
    setPromptDraft("")
    onSubmit(command.name, [])
  }

  const pickSuggestion = (item: ComposerSuggestion): void => {
    setDismissedQuery(queryKey)
    setHighlight(undefined)
    if (item.kind === "command") runSlashCommand(item)
    else if (item.kind === "file")
      editorRef.current?.replaceRange(
        tokenStart,
        tokenEnd,
        `${fileMentionText(item.file)} `,
      )
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
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      (sendShortcut === "enter" || event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault()
      submit()
      return true
    }
    return false
  }

  return (
    <footer className={className} data-composer-surface="">
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
            id={suggestionsId}
            open={menuOpen}
            items={suggestions}
            activeIndex={activeHighlight}
            listLabel={
              trigger === "@"
                ? "Files"
                : trigger === "$"
                  ? "Skills"
                  : "Slash commands"
            }
            error={trigger === "@" ? undefined : sessionSkillsError}
            emptyLabel={
              trigger === "@"
                ? query === ""
                  ? "Type to search for files"
                  : "No matching files"
                : undefined
            }
            onHighlight={(index) => setHighlight({ query: queryKey, index })}
            onPick={pickSuggestion}
          />
          <ContextExcerptChips
            excerpts={excerpts}
            onRemove={removePromptExcerpt}
            onChange={updatePromptExcerpt}
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
                        onAttachmentError(
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
            label={label}
            value={draft}
            placeholder={placeholder}
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
            suggestionsId={suggestionsId}
            activeSuggestion={
              menuOpen && suggestions.length > 0
                ? `${suggestionsId}-${activeHighlight}`
                : undefined
            }
            onBlur={() => setDismissedQuery(queryKey)}
            onFocus={() => setDismissedQuery(undefined)}
            onPasteImages={(images) => void addFiles(images)}
            onKeyDown={handleDraftKeyDown}
          />

          <div className="flex min-h-12 items-center justify-between gap-3 px-2.5 pb-2.5">
            <div className="relative flex shrink-0 items-center gap-1">
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
                disabled={readingImages || sending}
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

            <div className="flex min-w-0 items-center gap-1">
              {modelControls}
              {activeTurnId === undefined ? (
                <Button
                  type="submit"
                  size="icon-sm"
                  disabled={!canSend}
                  aria-label={sending ? "Sending" : sendLabel}
                  title={
                    compactBlocked
                      ? "Remove attachments and excerpts before compacting"
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
                  aria-label={stopping ? "Stopping" : stopLabel}
                  title={stopping ? "Stopping" : "Interrupt"}
                  className="rounded-full"
                  onClick={onCancel}
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
