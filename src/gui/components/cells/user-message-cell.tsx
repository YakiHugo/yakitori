import {
  FileText,
  ImageOff,
  LoaderCircle,
  MessageSquare,
  PencilLine,
  RotateCcw,
  Target,
} from "lucide-react"
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import type { ContextExcerpt } from "../../../kernel/input-context.ts"
import { imageAttachmentUrl } from "../../composer-attachments.ts"
import { contextSourceAttributes } from "../../conversation-context.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import { useAppStore } from "../../store/app-store.ts"
import { usePreferencesStore } from "../../store/preferences-store.ts"
import { useWorkspaceStore } from "../../store/workspace-store.ts"
import { ImageLightbox } from "../image-lightbox.tsx"
import { parsePrompt } from "../prompt-document.ts"
import { PromptEditor, type PromptEditorHandle } from "../prompt-editor.tsx"
import { CopyIconButton, MessageTimestamp } from "../response-actions.tsx"
import { Badge } from "../ui/badge.tsx"
import { Button } from "../ui/button.tsx"

function MessageText({ text }: Readonly<{ text: string }>) {
  const paragraphs: ReactNode[] = []
  parsePrompt(text).forEach((paragraph, paragraphOffset) => {
    const content: ReactNode[] = []
    paragraph.forEach((node, offset) => {
      content.push(
        node.isText ? (
          node.text
        ) : node.type.name === "skill" ? (
          <button
            type="button"
            // biome-ignore lint/suspicious/noArrayIndexKey: ProseMirror supplies document offsets, not array indices; admitted messages are immutable.
            key={offset}
            title={node.attrs.path}
            aria-label={`View ${node.attrs.name} skill`}
            className="mx-0.5 inline cursor-pointer rounded-md bg-primary-foreground/15 px-1.5 py-0.5 font-medium hover:bg-primary-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() =>
              useWorkspaceStore
                .getState()
                .openSkill(node.attrs.path, node.attrs.name)
            }
          >
            ${node.attrs.name}
          </button>
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: ProseMirror supplies document offsets, not array indices; admitted messages are immutable.
            key={offset}
            title={node.attrs.path}
            className="mx-0.5 inline rounded-md bg-primary-foreground/15 px-1.5 py-0.5 font-medium"
          >
            @{node.attrs.name}
          </span>
        ),
      )
    })
    paragraphs.push(
      // biome-ignore lint/suspicious/noArrayIndexKey: This is a ProseMirror document offset in an immutable admitted message.
      <p key={paragraphOffset}>{content.length ? content : <br />}</p>,
    )
  })
  return <div className="px-4 py-3 whitespace-pre-wrap">{paragraphs}</div>
}

export function UserMessageCell({
  entry,
  queued,
}: Readonly<{
  entry: Extract<ExecutionEntry, { kind: "user_input" }>
  queued: boolean
}>) {
  const busy = useAppStore((state) => state.busy)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const goalInputId = useAppStore((state) => state.selectedSession?.goalInputId)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const sentAsGoal = goalInputId !== undefined && goalInputId === entry.inputId
  const apiBase = useAppStore((state) => state.apiBase)
  const forkSession = useAppStore((state) => state.forkSession)
  const sendShortcut = usePreferencesStore((state) => state.sendShortcut)
  const [mode, setMode] = useState<"undo" | "edit" | undefined>()
  const [draft, setDraft] = useState(entry.text)
  const [previewIndex, setPreviewIndex] = useState<number>()
  const edited = draft.trim()
  const editorRef = useRef<PromptEditorHandle>(null)
  useLayoutEffect(() => {
    if (mode === "edit") {
      editorRef.current?.focus(true)
    }
  }, [mode])
  const attachments = entry.attachments ?? []
  const contextAttachments = entry.contextAttachments ?? []
  const hasAttachments = attachments.length > 0 || contextAttachments.length > 0
  const preview =
    previewIndex === undefined ? undefined : attachments[previewIndex]

  return (
    <div className="group flex flex-col items-end gap-1.5">
      {mode !== "edit" ? (
        <>
          {hasAttachments && (
            <section
              className="message-attachments"
              aria-label="Message attachments"
            >
              {attachments.length > 0 ? (
                <div className="message-image-row">
                  {attachments.map((attachment, index) => (
                    <MessageImage
                      key={`${apiBase}:${attachment.file.rolloutId}:${attachment.file.path}`}
                      src={imageAttachmentUrl(attachment, apiBase)}
                      name={attachment.name}
                      onClick={() => setPreviewIndex(index)}
                    />
                  ))}
                </div>
              ) : null}
              {contextAttachments.length > 0 ? (
                <MessageSources excerpts={contextAttachments} />
              ) : null}
            </section>
          )}
          {entry.text ? (
            <div
              className="message-bubble max-w-[85%] overflow-hidden rounded-2xl bg-primary text-[15px] leading-6 text-primary-foreground"
              {...contextSourceAttributes({
                kind: "message",
                label: "User message",
                messageId: entry.inputId,
                ...(sessionId ? { sessionId } : {}),
              })}
            >
              <MessageText text={entry.text} />
            </div>
          ) : null}
          {sentAsGoal ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Target className="size-3" />
              <span>Sent as goal</span>
            </div>
          ) : null}
          <div className="flex min-h-5 items-center gap-1">
            {queued ? <Badge variant="secondary">queued</Badge> : null}
            {mode === undefined ? (
              <div className="flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <MessageTimestamp at={entry.at} />
                <CopyIconButton text={entry.text} label="message" />
                {entry.text.trim() && sessionId !== undefined && !sentAsGoal ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="Set as goal"
                    title="Set as goal"
                    onClick={() =>
                      void changeSidebar({
                        type: "session",
                        sessionId,
                        goal: entry.text.trim(),
                        goalStatus: "active",
                        goalUpdatedAt: new Date().toISOString(),
                        goalTimeUsedSeconds: 0,
                        goalInputId: entry.inputId,
                      })
                    }
                    className="rounded-md p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <Target className="size-4" />
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Edit & resubmit"
                  title="Edit & resubmit"
                  onClick={() => {
                    setDraft(entry.text)
                    setMode("edit")
                  }}
                  className="rounded-md p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <PencilLine className="size-4" />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Undo to here"
                  title="Undo to here"
                  onClick={() => setMode("undo")}
                  className="rounded-md p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <RotateCcw className="size-4" />
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      {mode === "undo" ? (
        <div className="w-full max-w-lg rounded-md border bg-card p-3 shadow-sm">
          <p className="text-xs font-medium">
            Undo this message and everything after it?
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            The conversation will branch. Files and command effects stay as-is.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setMode(undefined)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => {
                void forkSession(entry.inputId, "undo")
              }}
            >
              <RotateCcw /> Undo
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "edit" ? (
        <form
          className="conversation-inline-edit w-full rounded-2xl bg-muted p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if ((edited.length === 0 && !hasAttachments) || busy) return
            void forkSession(entry.inputId, "edit", edited)
          }}
        >
          {attachments.length > 0 ? (
            <div className="mb-3 flex gap-2">
              {attachments.map((attachment) => (
                <img
                  key={attachment.file.path}
                  src={imageAttachmentUrl(attachment, apiBase)}
                  alt={attachment.name}
                  className="size-16 rounded-lg object-cover"
                />
              ))}
            </div>
          ) : null}
          <PromptEditor
            ref={editorRef}
            label="Edit message"
            value={draft}
            disabled={busy}
            onChange={setDraft}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setMode(undefined)
                return true
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.altKey &&
                (sendShortcut === "enter" || event.metaKey || event.ctrlKey)
              ) {
                if (!busy && (edited.length > 0 || hasAttachments))
                  void forkSession(entry.inputId, "edit", edited)
                return true
              }
              return false
            }}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setMode(undefined)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || (edited.length === 0 && !hasAttachments)}
            >
              Send
            </Button>
          </div>
        </form>
      ) : null}
      {preview === undefined ? null : (
        <ImageLightbox
          src={imageAttachmentUrl(preview, apiBase)}
          name={preview.name}
          onClose={() => setPreviewIndex(undefined)}
        />
      )}
    </div>
  )
}

function MessageSources({
  excerpts,
}: Readonly<{ excerpts: readonly ContextExcerpt[] }>) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const allAnnotations = excerpts.every(
    (excerpt) => excerpt.kind === "annotation",
  )
  const Icon = allAnnotations ? MessageSquare : FileText
  const label = allAnnotations
    ? excerpts.length === 1
      ? "1 annotation"
      : `${excerpts.length} annotations`
    : excerpts.length === 1
      ? "1 reference"
      : `${excerpts.length} references`

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!trigger.current || !popover.current) return
      const rect = trigger.current.getBoundingClientRect()
      const { width, height } = popover.current.getBoundingClientRect()
      setPosition({
        top:
          rect.top >= height + 16
            ? rect.top - height - 8
            : Math.min(window.innerHeight - height - 8, rect.bottom + 8),
        left: Math.max(
          8,
          Math.min(window.innerWidth - width - 8, rect.right - width),
        ),
      })
    }
    place()
    window.addEventListener("resize", place)
    document.addEventListener("scroll", place, { capture: true, passive: true })
    return () => {
      window.removeEventListener("resize", place)
      document.removeEventListener("scroll", place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !popover.current?.contains(event.target)
      )
        setOpen(false)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener("pointerdown", dismiss)
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      document.removeEventListener("keydown", keydown)
    }
  }, [open])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="message-sources-trigger"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon size={14} aria-hidden="true" />
        {label}
      </button>
      {open
        ? createPortal(
            <div
              ref={popover}
              className="message-sources-popover"
              style={position}
              role="dialog"
              aria-label={label}
            >
              {excerpts.map((excerpt, index) => (
                <div key={excerpt.id} className="message-sources-row">
                  <span className="message-sources-index">{index + 1}.</span>
                  <div>
                    <p className="message-sources-label">
                      {excerpt.source.label}
                    </p>
                    {excerpt.source.path || excerpt.source.url ? (
                      <p className="message-sources-location">
                        {excerpt.source.path ?? excerpt.source.url}
                      </p>
                    ) : null}
                    <blockquote>{excerpt.text}</blockquote>
                    {excerpt.kind === "annotation" && excerpt.comment ? (
                      <p className="message-sources-comment">
                        {excerpt.comment}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function MessageImage({
  src,
  name,
  onClick,
}: Readonly<{ src: string; name: string; onClick(): void }>) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    "loading",
  )
  return (
    <button
      type="button"
      aria-label={`Preview ${name}`}
      title={name}
      className="message-image"
      onClick={onClick}
      data-status={status}
    >
      <img
        src={src}
        alt={name}
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
      />
      {status === "loading" && (
        <span
          className="message-image-placeholder"
          role="status"
          aria-label={`Loading ${name}`}
        >
          <LoaderCircle
            size={16}
            className="animate-spin motion-reduce:animate-none"
          />
        </span>
      )}
      {status === "error" && (
        <span className="message-image-placeholder">
          <ImageOff size={18} />
          <span>Preview unavailable</span>
        </span>
      )}
    </button>
  )
}
