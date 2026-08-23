import { ArrowUp, LoaderCircle, Plus, ShieldCheck, X } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import { COMPACT_DIRECTIVE } from "../../kernel/events.ts"
import {
  appendImageFiles,
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

export function Composer() {
  const draft = useAppStore((state) => state.promptDraft) ?? ""
  const attachments = useAppStore((state) => state.promptAttachments)
  const busy = useAppStore((state) => state.busy)
  const focusRevision = useAppStore((state) => state.composerFocusRevision)
  const modelSelectionReady = useAppStore((state) => state.modelSelectionReady)
  const providers = useAppStore((state) => state.providers)
  const defaultProvider = useAppStore((state) => state.defaultProvider)
  const defaultModel = useAppStore((state) => state.defaultModel)
  const userPreference = useAppStore((state) => state.userPreference)
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const sessionId = useAppStore((state) => state.selection.sessionId)
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
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [attachmentError, setAttachmentError] = useState<string>()
  const [readingImages, setReadingImages] = useState(false)

  const effectiveModel = normalizeKimiModelSelection(
    resolveEffectiveModel({
      sessionCurrent,
      userPreference,
      defaultProvider,
      defaultModel,
    }),
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
    const textarea = textareaRef.current
    if (!textarea || textarea.value !== draft) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 52), 200)}px`
  }, [draft])

  useLayoutEffect(() => {
    if (focusRevision > 0) textareaRef.current?.focus()
  }, [focusRevision])

  const text = draft.trim()
  const sending =
    sessionId !== undefined && inFlightActions.has(`admit:${sessionId}`)
  const containsInput = text.length > 0 || attachments.length > 0
  const compactHasAttachments =
    text === COMPACT_DIRECTIVE && attachments.length > 0
  const canSend =
    containsInput &&
    sessionId !== undefined &&
    modelSelectionReady &&
    !busy &&
    !sending &&
    !readingImages &&
    !compactHasAttachments

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) return
    setReadingImages(true)
    setAttachmentError(undefined)
    try {
      setPromptAttachments(await appendImageFiles(attachments, files))
    } catch (error) {
      setAttachmentError(
        error instanceof Error
          ? error.message
          : "Images could not be attached.",
      )
    } finally {
      setReadingImages(false)
    }
  }

  const submit = () => {
    if (!canSend) return
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
        <div className="overflow-visible rounded-2xl border bg-card shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_7%,transparent),0_8px_24px_-10px_color-mix(in_oklab,var(--foreground)_14%,transparent)] transition-shadow focus-within:shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_8%,transparent),0_10px_30px_-10px_color-mix(in_oklab,var(--foreground)_20%,transparent)]">
          {attachments.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto px-3 pt-3">
              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.name}:${attachment.sizeBytes}:${attachment.data.slice(0, 24)}`}
                  className="group/image relative size-18 shrink-0 overflow-hidden rounded-xl border bg-muted"
                >
                  <img
                    src={imageAttachmentUrl(attachment)}
                    alt={attachment.name}
                    className="size-full object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() =>
                      setPromptAttachments(
                        attachments.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      )
                    }
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
                    disabled={!supportsOriginal}
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
            onChange={(event) => setPromptDraft(event.currentTarget.value)}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              )
              if (images.length === 0) return
              event.preventDefault()
              void addFiles(images)
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                submit()
              }
            }}
            className="max-h-50 min-h-13 w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/65 disabled:opacity-50"
          />

          <div className="flex min-h-12 items-center justify-between gap-3 px-2.5 pb-2.5">
            <div className="flex min-w-0 items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="sr-only"
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? [])
                  event.currentTarget.value = ""
                  void addFiles(files)
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={sessionId === undefined || readingImages}
                aria-label="Attach images"
                title="Attach images"
                className="rounded-full bg-muted/70"
                onClick={() => fileInputRef.current?.click()}
              >
                {readingImages ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Plus />
                )}
              </Button>
              <div
                className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground"
                title="Tools can write inside the selected workspace; other actions still follow runtime permissions."
              >
                <ShieldCheck className="size-4 shrink-0" />
                <span className="truncate">Workspace write</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <ModelSelector />
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${busy ? "animate-pulse bg-amber-500" : "bg-muted-foreground/25"}`}
              />
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
        <TelemetryRail telemetry={view.telemetry} />
      </form>
    </footer>
  )
}

function TelemetryRail({
  telemetry,
}: {
  readonly telemetry: ReturnType<typeof useExecutionView>["telemetry"]
}) {
  const cacheHit =
    telemetry.inputTokens === 0
      ? undefined
      : (telemetry.cacheReadInputTokens / telemetry.inputTokens) * 100
  const tokensPerSecond =
    telemetry.modelDurationMs === 0
      ? undefined
      : telemetry.outputTokens / (telemetry.modelDurationMs / 1_000)
  const items = [
    `${telemetry.turns} ${telemetry.turns === 1 ? "turn" : "turns"}`,
    `${telemetry.steps} steps`,
    `LLM ${formatDuration(telemetry.modelDurationMs)}`,
    `Tools ${formatDuration(telemetry.toolDurationMs)}`,
    `TTFT avg ${telemetry.averageTimeToFirstTokenMs === undefined ? "—" : formatDuration(telemetry.averageTimeToFirstTokenMs)}`,
    `${tokensPerSecond === undefined ? "—" : formatRate(tokensPerSecond)} tok/s`,
    `Cache hit ${cacheHit === undefined ? "—" : `${Math.round(cacheHit)}%`}`,
    `Input ${formatTokens(telemetry.inputTokens)} tok`,
  ]

  return (
    <div
      role="status"
      aria-label="Session telemetry"
      className="flex items-center justify-center gap-2 overflow-x-auto px-3 pt-2 text-[11px] whitespace-nowrap text-muted-foreground"
      title={`Provider-reported cache reads: ${formatTokens(telemetry.cacheReadInputTokens)} tokens · cache writes: ${formatTokens(telemetry.cacheWriteInputTokens)} tokens`}
    >
      {items.map((item, index) => (
        <span key={item} className="flex items-center gap-2">
          {index === 0 ? null : <span className="text-border">|</span>}
          {item}
        </span>
      ))}
    </div>
  )
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1_000)
  return `${minutes}m${seconds}s`
}

function formatRate(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString()
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}
