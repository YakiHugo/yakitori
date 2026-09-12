import { Package, PencilLine, RotateCcw } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { useAppStore } from "../../store/app-store.ts"
import { imageAttachmentUrl } from "../../composer-attachments.ts"
import { Badge } from "../ui/badge.tsx"
import { Button } from "../ui/button.tsx"

// Skill chips submitted from the composer travel as a trailing run of
// path-qualified mentions appended to the text; render that run as chips
// instead of raw markdown. Inline `[$x](y)` spans the user typed elsewhere
// in the message are left untouched.
const SKILL_MENTION_PATTERN = /\[\$([^\]]+)\]\(([^)]+)\)/g
const TRAILING_SKILL_MENTIONS = /(?:[^\S\n]*\[\$[^\]]+\]\([^)]+\))+\s*$/

function splitSkillMentions(text: string): {
  text: string
  mentions: readonly Readonly<{ name: string; path: string }>[]
} {
  if (!text.includes("[$")) return { text, mentions: [] }
  const trailing = TRAILING_SKILL_MENTIONS.exec(text)
  if (trailing === null) return { text, mentions: [] }
  const seen = new Set<string>()
  const mentions = [...trailing[0].matchAll(SKILL_MENTION_PATTERN)]
    .map((match) => ({
      name: match[1] ?? "",
      path: match[2] ?? "",
    }))
    .filter((mention) => {
      if (seen.has(mention.path)) return false
      seen.add(mention.path)
      return true
    })
  return { text: text.slice(0, trailing.index).trimEnd(), mentions }
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
  const editorRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (mode === "edit") {
      editorRef.current?.focus()
      const end = editorRef.current?.value.length ?? 0
      editorRef.current?.setSelectionRange(end, end)
    }
  }, [mode])
  const attachments = entry.attachments ?? []
  const display = splitSkillMentions(entry.text)

  return (
    <div className="group flex flex-col items-end gap-1.5">
      {mode !== "edit" ? (
        <>
          <div className="max-w-[85%] overflow-hidden rounded-xl bg-primary text-sm text-primary-foreground">
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
            {display.mentions.length > 0 ? (
              <div className="flex flex-wrap gap-1 px-3 pt-2">
                {display.mentions.map((mention) => (
                  <span
                    key={mention.path}
                    title={mention.path}
                    className="inline-flex items-center gap-1 rounded bg-primary-foreground/15 px-1.5 py-0.5 text-[11px]"
                  >
                    <Package className="size-3" />
                    {mention.name}
                  </span>
                ))}
              </div>
            ) : null}
            {display.text.length > 0 ? (
              <div className="px-3 py-2 whitespace-pre-wrap">
                {display.text}
              </div>
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
                    setDraft(display.text)
                    setMode("edit")
                  }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <PencilLine className="size-3" /> Edit &amp; resubmit
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
          className="w-full rounded-3xl bg-muted p-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (
              (edited.length === 0 &&
                attachments.length === 0 &&
                display.mentions.length === 0) ||
              busy
            )
              return
            void forkSession(
              entry.inputId,
              "edit",
              [
                edited,
                ...display.mentions.map(
                  (mention) => `[$${mention.name}](${mention.path})`,
                ),
              ]
                .filter(Boolean)
                .join(" "),
            )
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
          {display.mentions.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {display.mentions.map((mention) => (
                <span
                  key={mention.path}
                  className="rounded-md border px-2 py-1 text-xs"
                >
                  {mention.name}
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={editorRef}
            aria-label="Edit message"
            value={draft}
            rows={3}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === "Escape") {
                event.preventDefault()
                setMode(undefined)
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            className="field-sizing-content max-h-80 min-h-20 w-full resize-none bg-transparent text-[15px] leading-6 outline-none"
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
              disabled={
                busy ||
                (edited.length === 0 &&
                  attachments.length === 0 &&
                  display.mentions.length === 0)
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
