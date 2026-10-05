import { inputImageOwnership } from "../input-image-ownership.ts"
import type { InputPart } from "../../kernel/events.ts"
import {
  inputContentImages,
  inputContentText,
} from "../../kernel/input-content.ts"
import { textInputParts, trimInputParts } from "../input-parts.ts"
import {
  Archive,
  ArrowUp,
  BookOpen,
  ChartPie,
  FilePlus2,
  FolderSearch,
  Gauge,
  ImagePlus,
  LoaderCircle,
  type LucideIcon,
  MessageSquarePlus,
  Minimize2,
  Pencil,
  Pin,
  Plus,
  Server,
  SlidersHorizontal,
  Square,
  Target,
  X,
} from "lucide-react"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  COMPACT_DIRECTIVE,
  GOAL_DIRECTIVE,
  type ImageAttachment,
} from "../../kernel/events.ts"
import type { ContextExcerpt } from "../../kernel/input-context.ts"
import type { ApiSkillSummary } from "../../server/protocol.ts"
import {
  appendImageFiles,
  appendPickedImages,
  discardDraftImages,
  discardPickedImages,
  imageAttachmentUrl,
  pickImages as selectImages,
  validateImageFiles,
} from "../composer-attachments.ts"
import { usePreferencesStore } from "../store/preferences-store.ts"
import {
  type ComposerSuggestion,
  ComposerSuggestions,
} from "./composer-suggestions.tsx"
import { ImageLightbox } from "./image-lightbox.tsx"
import {
  fileMentionText,
  skillMentionText,
  promptPartsText,
} from "./prompt-document.ts"
import { PromptEditor, type PromptEditorHandle } from "./prompt-editor.tsx"
import { ContextExcerptChips } from "./selection-actions.tsx"
import { Button } from "./ui/button.tsx"

type SlashCommand = Readonly<{
  name: string
  description: string
  icon: LucideIcon
}>

const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "/status",
    description: "Show conversation context and usage limits",
    icon: Gauge,
  },
  { name: "/mcp", description: "Show MCP server status", icon: Server },
  {
    name: "/model",
    description: "Choose a model and reasoning effort",
    icon: SlidersHorizontal,
  },
  { name: "/usage", description: "Open usage and billing", icon: ChartPie },
  {
    name: "/side",
    description: "Start a temporary side chat",
    icon: MessageSquarePlus,
  },
  {
    name: "/archive",
    description: "Archive this conversation",
    icon: Archive,
  },
  { name: "/pin", description: "Pin or unpin this conversation", icon: Pin },
  {
    name: "/rename",
    description: "Rename this conversation",
    icon: Pencil,
  },
  {
    name: "/skills",
    description: "Browse skills in the composer",
    icon: BookOpen,
  },
  {
    name: "/init",
    description: "Ask the agent to create project instructions",
    icon: FilePlus2,
  },
  {
    name: COMPACT_DIRECTIVE,
    description: "Compact the conversation context",
    icon: Minimize2,
  },
  {
    name: GOAL_DIRECTIVE,
    description: "Set or edit the session goal",
    icon: Target,
  },
]

export type ComposerImageImport = (
  prepare: () => Promise<
    | {
        collect(sessionId?: string): Promise<readonly ImageAttachment[]>
        cleanup?: (() => Promise<void>) | undefined
      }
    | undefined
  >,
  validate?: () => void,
) => Promise<readonly ImageAttachment[] | undefined>

// Session creation and submission belong to the caller. Editor behavior and
// presentation are shared by the main conversation and temporary chats.
export function ComposerSurface({
  sessionId,
  editorKey,
  draft: parts,
  excerpts,
  sessionSkills,
  sessionSkillsError,
  commandPanel,
  dismissCommandPanel,
  apiBase,
  focusRevision = 0,
  busy = false,
  sending = false,
  stopping = false,
  activeTurnId,
  supportsImages = true,
  supportsOriginal = true,
  historyParts,
  setPromptDraft,
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
  fileSearchRoot,
  label = "Message the Mate",
  placeholder = "Ask anything",
  className = "conversation-composer-footer pt-3 pb-3",
  allowCommands = true,
  sendLabel = "Send",
  stopLabel = "Interrupt",
}: Readonly<{
  sessionId?: string | undefined
  editorKey?: string | number | undefined
  draft: readonly InputPart[]
  excerpts: readonly ContextExcerpt[]
  sessionSkills: readonly ApiSkillSummary[]
  sessionSkillsError?: string | undefined
  commandPanel?: ReactNode
  dismissCommandPanel?: () => void
  apiBase: string
  focusRevision?: number
  busy?: boolean
  sending?: boolean
  stopping?: boolean
  activeTurnId?: string | undefined
  supportsImages?: boolean
  supportsOriginal?: boolean
  historyParts: readonly (readonly InputPart[])[]
  setPromptDraft(parts: readonly InputPart[]): void
  removePromptExcerpt(id: string): void
  updatePromptExcerpt(excerpt: ContextExcerpt): void
  onSubmit(parts: readonly InputPart[], mode?: "auto" | "queue"): void
  onCancel(): void
  modelControls: ReactNode
  importImages: ComposerImageImport
  readingImages: boolean
  attachmentError?: string | undefined
  onAttachmentError(error: string): void
  // Powers the @-mention file picker; without it the @ trigger stays inert.
  searchFiles?:
    | ((query: string) => Promise<
        readonly Readonly<{
          name: string
          path: string
          kind?: "file" | "folder"
        }>[]
      >)
    | undefined
  fileSearchRoot?: string | undefined
  label?: string
  placeholder?: string
  className?: string
  allowCommands?: boolean
  sendLabel?: string
  stopLabel?: string
}>) {
  const suggestionsId = useId()
  const sendShortcut = usePreferencesStore((state) => state.sendShortcut)
  const draft = promptPartsText(parts)
  const attachments = inputContentImages({ kind: "parts", parts })
  const editorRef = useRef<PromptEditorHandle | null>(null)
  const contextPanelRef = useRef<HTMLDivElement>(null)
  const addContextRef = useRef<HTMLButtonElement>(null)
  const menuSession = useRef(sessionId)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [addHighlight, setAddHighlight] = useState(0)
  const [previewIndex, setPreviewIndex] = useState<number>()
  const [historyNavigation, setHistoryNavigation] =
    useState<
      Readonly<{
        sessionId: string | undefined
        stepsBack: number
        savedDraft: readonly InputPart[]
      }>
    >()
  // A recalled input temporarily replaces the editor, but this surface still
  // owns the unsent snapshot, including across session-keyed editor remounts.
  const parkedOwner = useRef<readonly InputPart[] | undefined>(undefined)
  const currentOwner = useRef({ parts, apiBase, onAttachmentError })
  useLayoutEffect(() => {
    currentOwner.current = { parts, apiBase, onAttachmentError }
  })
  const releaseParked = useCallback(
    (previous: readonly InputPart[], next: readonly InputPart[] = []) => {
      const live = new Set(
        inputImageOwnership
          .resolveParts(currentOwner.current.apiBase, [
            ...currentOwner.current.parts,
            ...next,
          ])
          .flatMap((part) =>
            part.type === "image"
              ? [`${part.file.rolloutId}\0${part.file.path}`]
              : [],
          ),
      )
      const unused = inputContentImages({
        kind: "parts",
        parts: inputImageOwnership.resolveParts(
          currentOwner.current.apiBase,
          previous,
        ),
      }).filter(
        (image) =>
          image.file.path.startsWith("attachments/staging/") &&
          !live.has(`${image.file.rolloutId}\0${image.file.path}`),
      )
      if (unused.length)
        void discardDraftImages(unused).catch((error: unknown) =>
          currentOwner.current.onAttachmentError(
            error instanceof Error
              ? error.message
              : "Unused images could not be released.",
          ),
        )
    },
    [],
  )
  useLayoutEffect(() => {
    const previous = parkedOwner.current
    const next = historyNavigation?.savedDraft
    parkedOwner.current = next
    if (previous && previous !== next) releaseParked(previous, next)
  }, [historyNavigation?.savedDraft, releaseParked])
  useEffect(
    () => () => {
      if (parkedOwner.current) releaseParked(parkedOwner.current)
    },
    [releaseParked],
  )
  const [dismissedQuery, setDismissedQuery] = useState<string>()
  const [highlight, setHighlight] = useState<{ query: string; index: number }>()
  const [selection, setSelection] = useState({
    from: draft.length,
    to: draft.length,
  })
  const [fileMatches, setFileMatches] = useState<{
    key: string
    items: readonly Readonly<{
      name: string
      path: string
      kind?: "file" | "folder"
    }>[]
  }>()
  const cursor = selection.from
  const hasSelection = selection.from !== selection.to

  useLayoutEffect(() => {
    if (focusRevision > 0) editorRef.current?.focus()
  }, [focusRevision])

  useEffect(() => {
    if (menuSession.current !== sessionId) {
      menuSession.current = sessionId
      setAddMenuOpen(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!addMenuOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !contextPanelRef.current?.contains(event.target) &&
        !addContextRef.current?.contains(event.target)
      )
        setAddMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false)
    }
    document.addEventListener("pointerdown", closeOnOutsideClick)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [addMenuOpen])

  // Navigation parked for another session must not leak into this one.
  const activeHistoryNavigation =
    historyNavigation?.sessionId === sessionId ? historyNavigation : undefined

  const prefix = draft.slice(0, cursor)
  const token = /(?:^|[\s\uFFFC])([/$@])([\p{L}\p{N}_:./-]*)$/u.exec(prefix)
  const query = token?.[2] ?? ""
  const trigger = token?.[1]
  const tokenStart = cursor - query.length - 1
  const tokenEnd =
    cursor + (/^[\p{L}\p{N}_:./-]*/u.exec(draft.slice(cursor))?.[0].length ?? 0)
  const queryKey = `${sessionId}:${fileSearchRoot}:${tokenStart}:${trigger}:${query}`
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
          draft.slice(tokenEnd).replaceAll("\uFFFC", "").trim().length === 0
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

  useLayoutEffect(() => {
    const panel = contextPanelRef.current
    const composer = panel?.parentElement
    if (!menuOpen || !panel || !composer) return
    const updateAvailableHeight = () => {
      panel.style.setProperty(
        "--composer-popup-available",
        `${Math.max(72, composer.getBoundingClientRect().top - 12)}px`,
      )
    }
    updateAvailableHeight()
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(updateAvailableHeight)
    observer?.observe(composer)
    window.addEventListener("resize", updateAvailableHeight)
    window.addEventListener("scroll", updateAvailableHeight, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", updateAvailableHeight)
      window.removeEventListener("scroll", updateAvailableHeight, true)
    }
  }, [menuOpen])

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

  const text = inputContentText({ kind: "parts", parts }).trim()
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
    const insertion = editorRef.current?.captureImageInsertion()
    try {
      const added = await importImages(
        async () => ({
          collect: (importSessionId) =>
            appendImageFiles([], importSessionId, files),
        }),
        () => validateImageFiles(files),
      )
      if (added?.length && !insertion?.insert(added))
        await discardDraftImages(added)
    } finally {
      insertion?.cancel()
    }
  }

  const pickImages = async () => {
    setAddMenuOpen(false)
    const insertion = editorRef.current?.captureImageInsertion()
    try {
      const added = await importImages(async () => {
        const selection = await selectImages()
        if (selection === undefined) return
        return {
          collect: (importSessionId) =>
            appendPickedImages([], importSessionId, selection.selectionId),
          cleanup: () => discardPickedImages(selection.selectionId),
        }
      })
      if (added?.length && !insertion?.insert(added))
        await discardDraftImages(added)
    } finally {
      insertion?.cancel()
    }
  }

  const pickAddAction = (action: "files" | "image") => {
    setAddMenuOpen(false)
    if (action === "image") {
      void pickImages()
    } else if (searchFiles) {
      const prefix =
        selection.from > 0 && !/\s/u.test(draft[selection.from - 1] ?? "")
          ? " "
          : ""
      const suffix =
        selection.to < draft.length && !/\s/u.test(draft[selection.to] ?? "")
          ? " "
          : ""
      editorRef.current?.replaceRange(
        selection.from,
        selection.to,
        `${prefix}@${suffix}`,
        prefix.length + 1,
      )
    }
  }

  const submit = (mode?: "auto" | "queue") => {
    if (!canSend) return
    setHistoryNavigation(undefined)
    // Preserve authored detail in durable history and admission identity.
    // Runtime projects it to the selected model before preparing image bytes.
    onSubmit(trimInputParts(parts), mode)
  }

  // Selecting a command dispatches it right away, like codex: the draft
  // clears and the command runs. When execution is currently blocked —
  // mid-restore, busy, or compact with staged images, which the compact lane
  // rejects — the selection only completes the text so nothing is lost.
  const runSlashCommand = (command: SlashCommand): void => {
    setDismissedQuery(queryKey)
    setHighlight(undefined)
    // /goal always takes an argument, so completing the text is the whole
    // interaction; the submit path in Composer interprets the directive.
    if (command.name === GOAL_DIRECTIVE) {
      editorRef.current?.replaceRange(
        tokenStart,
        tokenEnd,
        `${GOAL_DIRECTIVE} `,
      )
      editorRef.current?.focus()
      return
    }
    const blocked =
      attachments.length > 0 ||
      (command.name === COMPACT_DIRECTIVE && sessionId === undefined) ||
      (command.name !== "/status" &&
        command.name !== "/mcp" &&
        (busy || sending)) ||
      (command.name === COMPACT_DIRECTIVE &&
        (attachments.length > 0 || excerpts.length > 0))
    if (blocked) {
      editorRef.current?.replaceRange(tokenStart, tokenEnd, command.name)
      editorRef.current?.focus()
      return
    }
    setDismissedQuery(
      `${sessionId}:${fileSearchRoot}:0:/:${command.name.slice(1)}`,
    )
    // The caller clears the draft after the action succeeds. This preserves
    // the command when an asynchronous operation (notably /compact) fails.
    setPromptDraft(textInputParts(command.name))
    onSubmit(textInputParts(command.name))
  }

  const pickSuggestion = (item: ComposerSuggestion): void => {
    setDismissedQuery(queryKey)
    setHighlight(undefined)
    if (item.kind === "command") runSlashCommand(item)
    else if (item.kind === "file")
      editorRef.current?.replaceRange(
        tokenStart,
        tokenEnd,
        `${fileMentionText(item.file)}${/^\s/u.test(draft.slice(tokenEnd)) ? "" : " "}`,
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
    if (addMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        setAddMenuOpen(false)
        return true
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        setAddHighlight(searchFiles ? (addHighlight === 0 ? 1 : 0) : 1)
        return true
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault()
        pickAddAction(addHighlight === 0 && searchFiles ? "files" : "image")
        return true
      }
    }
    if (!menuOpen && commandPanel && event.key === "Escape") {
      event.preventDefault()
      dismissCommandPanel?.()
      return true
    }
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
      const entry = historyParts[historyParts.length - stepsBack]
      if (entry === undefined) return false
      setHistoryNavigation({
        sessionId,
        stepsBack,
        savedDraft: activeHistoryNavigation?.savedDraft ?? parts,
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
      const entry = historyParts[historyParts.length - stepsBack]
      if (entry === undefined) return false
      setHistoryNavigation({ ...activeHistoryNavigation, stepsBack })
      setPromptDraft(entry)
      return true
    }
    if (event.key === "Enter" && !event.altKey) {
      const mod = event.metaKey || event.ctrlKey
      // Queue-for-next-turn gestures: Mod+Enter in enter mode (plain Enter
      // already sends); Shift+Mod+Enter in mod-enter mode (the plain chord
      // is already "send"). Sending steers an active Turn; queueing runs the
      // input as the next Turn.
      const queue =
        mod && (sendShortcut === "enter" ? !event.shiftKey : event.shiftKey)
      if (queue) {
        event.preventDefault()
        submit("queue")
        return true
      }
      if (!event.shiftKey && (sendShortcut === "enter" || mod)) {
        event.preventDefault()
        submit()
        return true
      }
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
          <div
            ref={contextPanelRef}
            hidden={!addMenuOpen && !menuOpen && !commandPanel}
            aria-hidden={!addMenuOpen && !menuOpen && !commandPanel}
            inert={!addMenuOpen && !menuOpen && !commandPanel}
            className="composer-suggestion-panel absolute bottom-full left-0 z-20 mb-1.5 w-full overflow-hidden rounded-[20px] border bg-popover shadow-[0_12px_32px_-16px_color-mix(in_oklab,var(--foreground)_15%,transparent),0_2px_8px_-4px_color-mix(in_oklab,var(--foreground)_10%,transparent)]"
          >
            {addMenuOpen ? (
              <div
                id={`${suggestionsId}-add`}
                role="listbox"
                aria-label="Add context"
                className="p-2 text-sm"
              >
                <div className="px-2 pt-1 pb-1.5 text-[13px] text-muted-foreground">
                  Add
                </div>
                <button
                  type="button"
                  role="option"
                  aria-label="Files and folders"
                  aria-selected={addHighlight === 0}
                  disabled={!searchFiles}
                  title={searchFiles ? undefined : "Select a project to browse"}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    if (searchFiles) setAddHighlight(0)
                  }}
                  onClick={() => pickAddAction("files")}
                  className={`flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-[14px] leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${addHighlight === 0 ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/60"}`}
                >
                  <FolderSearch className="size-4 shrink-0 text-muted-foreground" />
                  <span>Files and folders</span>
                  {!searchFiles ? (
                    <span className="truncate text-muted-foreground">
                      Select a project to browse
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="option"
                  aria-label="Add image"
                  aria-selected={addHighlight === 1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setAddHighlight(1)}
                  onClick={() => pickAddAction("image")}
                  className={`flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-[14px] leading-5 transition-colors ${addHighlight === 1 ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/60"}`}
                >
                  <ImagePlus className="size-4 shrink-0 text-muted-foreground" />
                  <span>Images</span>
                </button>
              </div>
            ) : menuOpen ? (
              <ComposerSuggestions
                id={suggestionsId}
                items={suggestions}
                activeIndex={activeHighlight}
                listLabel={
                  trigger === "@"
                    ? "Files and folders"
                    : trigger === "$"
                      ? "Skills"
                      : "Slash commands"
                }
                showHeaders={query.length === 0}
                error={trigger === "@" ? undefined : sessionSkillsError}
                emptyLabel={
                  trigger === "@"
                    ? query === ""
                      ? "Type to search for files"
                      : "No matching files"
                    : undefined
                }
                onHighlight={(index) =>
                  setHighlight({ query: queryKey, index })
                }
                onPick={pickSuggestion}
              />
            ) : (
              commandPanel
            )}
          </div>
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
                    onClick={() => editorRef.current?.removeImage(index)}
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
                      editorRef.current?.setImageDetail(
                        index,
                        attachment.detail === "original" ? "high" : "original",
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
            key={editorKey ?? sessionId}
            ref={editorRef}
            label={label}
            value={parts}
            parkedParts={historyNavigation?.savedDraft}
            apiBase={apiBase}
            placeholder={placeholder}
            disabled={sending}
            onChange={(text) => {
              dismissCommandPanel?.()
              setAddMenuOpen(false)
              setDismissedQuery(undefined)
              setHistoryNavigation(undefined)
              setPromptDraft(text)
            }}
            onSelection={(from, to) => {
              setSelection({ from, to })
            }}
            menuOpen={menuOpen && !addMenuOpen}
            suggestionsId={suggestionsId}
            activeSuggestion={
              menuOpen && !addMenuOpen && suggestions.length > 0
                ? `${suggestionsId}-${activeHighlight}`
                : undefined
            }
            onBlur={() => setDismissedQuery(queryKey)}
            onFocus={() => {
              setDismissedQuery(undefined)
              setAddMenuOpen(false)
            }}
            onPasteImages={(images) => void addFiles(images)}
            onPreviewImage={(image) =>
              setPreviewIndex(
                attachments.findIndex(
                  (candidate) =>
                    candidate.file.rolloutId === image.file.rolloutId &&
                    candidate.file.path === image.file.path,
                ),
              )
            }
            onDiscardImages={(images) => {
              void discardDraftImages(images).catch((error: unknown) =>
                onAttachmentError(
                  error instanceof Error
                    ? error.message
                    : "Unused images could not be released.",
                ),
              )
            }}
            onKeyDown={handleDraftKeyDown}
          />

          <div className="flex min-h-12 items-center justify-between gap-3 px-2.5 pb-2.5">
            <div className="relative flex shrink-0 items-center gap-1">
              <Button
                ref={addContextRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={readingImages || sending}
                aria-label="Add context"
                aria-expanded={addMenuOpen}
                aria-controls={`${suggestionsId}-add`}
                title="Add context"
                className={`relative rounded-full text-muted-foreground hover:text-foreground ${addMenuOpen ? "z-20" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  editorRef.current?.focus()
                  setAddHighlight(searchFiles ? 0 : 1)
                  setAddMenuOpen((open) => !open)
                  setDismissedQuery(queryKey)
                }}
              >
                {readingImages ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plus
                    className={`transition-transform duration-150 ${addMenuOpen ? "rotate-45" : ""}`}
                  />
                )}
              </Button>
            </div>

            <div className="flex min-w-0 items-center gap-1">
              {modelControls}
              {activeTurnId === undefined ? (
                <Button
                  type="submit"
                  size="icon-sm"
                  disabled={!canSend}
                  aria-busy={sending}
                  aria-label={sending ? "Sending" : sendLabel}
                  title={
                    sending
                      ? "Sending…"
                      : compactBlocked
                        ? "Remove attachments and excerpts before compacting"
                        : "Send message"
                  }
                  className="rounded-full"
                >
                  {sending ? (
                    <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <ArrowUp />
                  )}
                  <span className="sr-only">
                    {sending ? "Sending" : "Send"}
                  </span>
                </Button>
              ) : (
                // A stop action, not a submit: Enter still follows the
                // unchanged input path while the turn is active.
                <Button
                  type="button"
                  size="icon-sm"
                  disabled={stopping}
                  aria-busy={stopping}
                  aria-label={stopping ? "Stopping" : stopLabel}
                  title={stopping ? "Stopping" : "Interrupt"}
                  className="rounded-full"
                  onClick={onCancel}
                >
                  {stopping ? (
                    <LoaderCircle className="animate-spin motion-reduce:animate-none" />
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
