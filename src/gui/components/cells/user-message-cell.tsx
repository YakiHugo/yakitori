import { ImageOff, LoaderCircle, PencilLine, Target } from "lucide-react"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { assetSourceKey } from "../../../protocol/asset-types.ts"
import {
  inputContent,
  inputContentAttachments,
} from "../../../protocol/user-input.ts"
import { attachmentUrl } from "../../composer-attachments.ts"
import { contextSourceAttributes } from "../../conversation-context.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import {
  hasInputDraft,
  inputDisplayParts,
  trimInputDraft,
} from "../../input-draft.ts"
import { useAppStore } from "../../store/app-store.ts"
import { usePreferencesStore } from "../../store/preferences-store.ts"
import { useWorkspaceStore } from "../../store/workspace-store.ts"
import { ContextExcerptCards } from "../context-excerpt-cards.tsx"
import { ImageLightbox } from "../image-lightbox.tsx"
import { openPdfAttachment, PdfAttachmentCard } from "../pdf-attachment.tsx"
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
  const goalInputId = useAppStore(
    (state) => state.selectedSession?.goal?.inputId,
  )
  const sentAsGoal = goalInputId !== undefined && goalInputId === entry.inputId
  const apiBase = useAppStore((state) => state.apiBase)
  const forkSession = useAppStore((state) => state.forkSession)
  const sendShortcut = usePreferencesStore((state) => state.sendShortcut)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.content)
  const [previewIndex, setPreviewIndex] = useState<number>()
  const [openError, setOpenError] = useState<string>()
  const edited = trimInputDraft(draft)
  const editorRef = useRef<PromptEditorHandle>(null)
  useLayoutEffect(() => {
    if (editing) {
      editorRef.current?.focus(true)
    }
  }, [editing])
  const attachments = inputContentAttachments(inputContent(entry.content))
  const contextAttachments = entry.contextAttachments ?? []
  const preview =
    previewIndex === undefined ? undefined : attachments[previewIndex]

  return (
    <div className="group flex flex-col items-end gap-1.5">
      {!editing ? (
        <>
          {contextAttachments.length > 0 ? (
            <section
              className="message-attachments"
              aria-label="Message sources"
            >
              <ContextExcerptCards excerpts={contextAttachments} />
            </section>
          ) : null}
          {inputDisplayParts(entry.content).map((part, index) => {
            const key = `${entry.inputId}:${index}`
            if (part.type === "document")
              return (
                <PdfAttachmentCard
                  key={key}
                  attachment={part}
                  apiBase={apiBase}
                />
              )
            if (part.type === "image")
              return (
                <div key={key} className="message-attachments">
                  <MessageImage
                    src={attachmentUrl(part, apiBase)}
                    name={part.name}
                    onClick={() =>
                      setPreviewIndex(
                        attachments.findIndex(
                          (image) =>
                            assetSourceKey(image.file) ===
                            assetSourceKey(part.file),
                        ),
                      )
                    }
                  />
                </div>
              )
            return part.text ? (
              <div
                key={key}
                className="message-bubble max-w-[85%] overflow-hidden rounded-2xl bg-primary text-body text-primary-foreground"
                {...contextSourceAttributes(
                  sessionId
                    ? {
                        kind: "message",
                        label: "User message",
                        messageId: entry.inputId,
                        sessionId,
                      }
                    : undefined,
                )}
              >
                <MessageText text={part.text} />
              </div>
            ) : null
          })}
          {sentAsGoal ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Target className="size-3" />
              <span>Sent as goal</span>
            </div>
          ) : null}
          <div className="flex min-h-5 items-center gap-1">
            {queued ? <Badge variant="secondary">queued</Badge> : null}
            <div className="flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <MessageTimestamp at={entry.at} />
              <CopyIconButton text={entry.text} label="message" />
              <button
                type="button"
                disabled={busy}
                aria-label="Edit & resubmit"
                title="Edit & resubmit"
                onClick={() => {
                  setDraft(entry.content)
                  setEditing(true)
                }}
                className="rounded-md p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <PencilLine className="size-4" />
              </button>
            </div>
          </div>
        </>
      ) : null}
      {openError === undefined ? null : <p role="alert">{openError}</p>}
      {editing ? (
        <form
          className="conversation-inline-edit w-full rounded-2xl bg-muted p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (
              (!hasInputDraft(edited) && contextAttachments.length === 0) ||
              busy
            )
              return
            void forkSession(entry.inputId, "edit", inputContent(edited))
          }}
        >
          <PromptEditor
            ref={editorRef}
            label="Edit message"
            value={draft}
            apiBase={apiBase}
            disabled={busy}
            onChange={setDraft}
            onOpenDocument={(document) => {
              void openPdfAttachment(document, apiBase).catch(
                (error: unknown) =>
                  setOpenError(
                    error instanceof Error
                      ? error.message
                      : "Could not open PDF.",
                  ),
              )
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setEditing(false)
                return true
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.altKey &&
                (sendShortcut === "enter" || event.metaKey || event.ctrlKey)
              ) {
                if (
                  !busy &&
                  (hasInputDraft(edited) || contextAttachments.length > 0)
                )
                  void forkSession(entry.inputId, "edit", inputContent(edited))
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
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={
                busy ||
                (!hasInputDraft(edited) && contextAttachments.length === 0)
              }
            >
              Send
            </Button>
          </div>
        </form>
      ) : null}
      {preview === undefined ||
      preview.mediaType === "application/pdf" ? null : (
        <ImageLightbox
          src={attachmentUrl(preview, apiBase)}
          name={preview.name}
          onClose={() => setPreviewIndex(undefined)}
        />
      )}
    </div>
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
