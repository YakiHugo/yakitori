import { openPdfAttachment } from "./pdf-attachment.tsx"
import { attachmentUrl } from "../composer-attachments.ts"
import { ImageLightbox } from "./image-lightbox.tsx"
import type { InputPart, ImageAttachment } from "../../kernel/events.ts"
import {
  inputContentAttachments,
  inputContentText,
} from "../../kernel/input-content.ts"
import { trimInputParts } from "../input-parts.ts"
import { PromptEditor } from "./prompt-editor.tsx"
import { useState } from "react"
import { ArrowDown, ArrowUp, Pencil, Play, X } from "lucide-react"
import { useAppStore } from "../store/app-store.ts"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

export function QueuedInputs() {
  const apiBase = useAppStore((state) => state.apiBase)
  const queued = useAppStore((state) => state.queuedItems)
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const cancelQueuedInput = useAppStore((state) => state.cancelQueuedInput)
  const updateQueuedInput = useAppStore((state) => state.updateQueuedInput)
  const reorderQueuedInputs = useAppStore((state) => state.reorderQueuedInputs)
  const startQueuedInput = useAppStore((state) => state.startQueuedInput)
  const [editingId, setEditingId] = useState<string>()
  const [openError, setOpenError] = useState<string>()
  const [preview, setPreview] = useState<ImageAttachment>()
  const [editingParts, setEditingParts] = useState<readonly InputPart[]>([])

  if (queued.length === 0) return null

  return (
    <div className="space-y-1 border-t bg-muted/40 px-4 py-2">
      {openError === undefined ? null : <p role="alert">{openError}</p>}
      {preview ? (
        <ImageLightbox
          src={attachmentUrl(preview, apiBase)}
          name={preview.name}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
      {queued.map((item, index) => (
        <div
          key={item.id}
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Badge variant="secondary">queued</Badge>
          {editingId === item.id ? (
            <form
              className="flex min-w-0 flex-1 gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                void updateQueuedInput(item.id, trimInputParts(editingParts))
                setEditingId(undefined)
              }}
            >
              <PromptEditor
                label="Edit queued input"
                apiBase={apiBase}
                className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-foreground"
                value={editingParts}
                onChange={setEditingParts}
                onPreviewImage={setPreview}
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
                    setEditingId(undefined)
                    return true
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    void updateQueuedInput(
                      item.id,
                      trimInputParts(editingParts),
                    )
                    setEditingId(undefined)
                    return true
                  }
                  return false
                }}
              />
              <Button type="submit" size="sm">
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditingId(undefined)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate">
                {inputContentText(item.input.content) || "Attachment"}
                {inputContentAttachments(item.input.content).length > 0
                  ? ` · ${inputContentAttachments(item.input.content).length} attachment(s)`
                  : ""}
              </span>
              <QueueButton
                label="Edit queued input"
                onClick={() => {
                  setEditingId(item.id)
                  setEditingParts(item.input.content.parts)
                }}
              >
                <Pencil />
              </QueueButton>
              <QueueButton
                label="Move queued input up"
                disabled={index === 0}
                onClick={() => {
                  const ids = queued.map((entry) => entry.id)
                  const [moved] = ids.splice(index, 1)
                  if (moved !== undefined) {
                    ids.splice(index - 1, 0, moved)
                    void reorderQueuedInputs(ids)
                  }
                }}
              >
                <ArrowUp />
              </QueueButton>
              <QueueButton
                label="Move queued input down"
                disabled={index === queued.length - 1}
                onClick={() => {
                  const ids = queued.map((entry) => entry.id)
                  const [moved] = ids.splice(index, 1)
                  if (moved !== undefined) {
                    ids.splice(index + 1, 0, moved)
                    void reorderQueuedInputs(ids)
                  }
                }}
              >
                <ArrowDown />
              </QueueButton>
              <QueueButton
                label="Start queued input"
                onClick={() => void startQueuedInput(item.id)}
              >
                <Play />
              </QueueButton>
              <QueueButton
                label="Cancel queued input"
                disabled={inFlightActions.has(`cancel-input:${item.id}`)}
                onClick={() => void cancelQueuedInput(item.id)}
              >
                <X />
              </QueueButton>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function QueueButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
