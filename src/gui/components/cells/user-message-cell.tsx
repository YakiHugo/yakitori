import { PencilLine, RotateCcw, X } from "lucide-react"
import { useState } from "react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { useAppStore } from "../../store/app-store.ts"
import { imageAttachmentUrl } from "../../composer-attachments.ts"
import { Badge } from "../ui/badge.tsx"
import { Button } from "../ui/button.tsx"

export function UserMessageCell({
  entry,
  queued,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "user_input" }>
  readonly queued: boolean
}) {
  const busy = useAppStore((state) => state.busy)
  const apiBase = useAppStore((state) => state.apiBase)
  const forkSession = useAppStore((state) => state.forkSession)
  const [mode, setMode] = useState<"undo" | "edit" | undefined>()
  const [draft, setDraft] = useState(entry.text)
  const edited = draft.trim()
  const attachments = entry.attachments ?? []

  return (
    <div className="group flex flex-col items-end gap-1.5">
      <div className="max-w-[85%] overflow-hidden rounded-xl bg-primary text-sm text-primary-foreground">
        {attachments.length > 0 ? (
          <div
            className={`grid gap-1.5 p-1.5 ${attachments.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
          >
            {attachments.map((attachment) => (
              <img
                key={`${attachment.name}:${attachment.sizeBytes}:${attachment.file.sessionId}:${attachment.file.path}`}
                src={imageAttachmentUrl(attachment, apiBase)}
                alt={attachment.name}
                className="max-h-72 min-h-24 w-full rounded-lg bg-black/10 object-cover"
              />
            ))}
          </div>
        ) : null}
        {entry.text.length > 0 ? (
          <div className="px-3 py-2 whitespace-pre-wrap">{entry.text}</div>
        ) : null}
      </div>
      <div className="flex min-h-5 items-center gap-1">
        {queued ? <Badge variant="secondary">queued</Badge> : null}
        {mode === undefined ? (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode("undo")}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <RotateCcw className="size-3" /> Undo to here
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(entry.text)
                setMode("edit")
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <PencilLine className="size-3" /> Edit &amp; resubmit
            </button>
          </div>
        ) : null}
      </div>

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
              variant="ghost"
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
                void forkSession(entry.inputId, "undo").then(() =>
                  setMode(undefined),
                )
              }}
            >
              <RotateCcw /> Undo
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "edit" ? (
        <form
          className="w-full max-w-lg rounded-md border bg-card p-3 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault()
            if (edited.length === 0 || busy) return
            void forkSession(entry.inputId, "edit", edited).then(() =>
              setMode(undefined),
            )
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium">Edit message</p>
              <p className="text-[11px] text-muted-foreground">
                Attached images will be kept.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close editor"
              disabled={busy}
              onClick={() => setMode(undefined)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <textarea
            aria-label="Edit message"
            value={draft}
            rows={3}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
            className="max-h-48 min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setMode(undefined)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || edited.length === 0}
            >
              <PencilLine /> Save &amp; send
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
