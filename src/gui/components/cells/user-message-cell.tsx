import { PencilLine, RotateCcw } from "lucide-react"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { useAppStore } from "../../store/app-store.ts"
import { imageAttachmentUrl } from "../../composer-attachments.ts"
import { Badge } from "../ui/badge.tsx"
import { Button } from "../ui/button.tsx"
import { CopyIconButton, MessageTimestamp } from "../response-actions.tsx"

import { PromptEditor, type PromptEditorHandle } from "../prompt-editor.tsx"
import { parsePrompt } from "../prompt-document.ts"

function MessageText({ text }: Readonly<{ text: string }>) {
  const paragraphs: ReactNode[] = []
  parsePrompt(text).forEach((paragraph, paragraphOffset) => {
    const content: ReactNode[] = []
    paragraph.forEach((node, offset) => {
      content.push(
        node.isText ? (
          node.text
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: ProseMirror supplies document offsets, not array indices; admitted messages are immutable.
            key={offset}
            title={node.attrs.path}
            className="mx-0.5 inline rounded-md bg-primary-foreground/15 px-1.5 py-0.5 font-medium"
          >
            ${node.attrs.name}
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
  const apiBase = useAppStore((state) => state.apiBase)
  const forkSession = useAppStore((state) => state.forkSession)
  const [mode, setMode] = useState<"undo" | "edit" | undefined>()
  const [draft, setDraft] = useState(entry.text)
  const edited = draft.trim()
  const editorRef = useRef<PromptEditorHandle>(null)
  useLayoutEffect(() => {
    if (mode === "edit") {
      editorRef.current?.focus(true)
    }
  }, [mode])
  const attachments = entry.attachments ?? []

  return (
    <div className="group flex flex-col items-end gap-1.5">
      {mode !== "edit" ? (
        <>
          <div className="max-w-[85%] overflow-hidden rounded-3xl bg-primary text-[15px] leading-6 text-primary-foreground">
            {attachments.length > 0 ? (
              <div
                className={`grid gap-1.5 p-1.5 ${attachments.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
              >
                {attachments.map((attachment) => (
                  <img
                    key={`${attachment.name}:${attachment.sizeBytes}:${attachment.file.rolloutId}:${attachment.file.path}`}
                    src={imageAttachmentUrl(attachment, apiBase)}
                    alt={attachment.name}
                    className="max-h-72 min-h-24 w-full rounded-lg bg-black/10 object-cover"
                  />
                ))}
              </div>
            ) : null}
            {entry.text ? <MessageText text={entry.text} /> : null}
          </div>
          <div className="flex min-h-5 items-center gap-1">
            {queued ? <Badge variant="secondary">queued</Badge> : null}
            {mode === undefined ? (
              <div className="flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <MessageTimestamp at={entry.at} />
                <CopyIconButton text={entry.text} label="message" />
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
          className="conversation-inline-edit w-full rounded-3xl bg-muted p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if ((edited.length === 0 && attachments.length === 0) || busy)
              return
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
              if (event.key === "Enter" && !event.shiftKey) {
                if (!busy && (edited.length > 0 || attachments.length > 0))
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
              disabled={
                busy || (edited.length === 0 && attachments.length === 0)
              }
            >
              Send
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
