import { useLayoutEffect, useRef } from "react"
import { useAppStore, useExecutionView } from "../store/app-store.ts"
import { ModelSelector } from "./model-selector.tsx"
import { Button } from "./ui/button.tsx"

export function Composer() {
  const draft = useAppStore((state) => state.promptDraft) ?? ""
  const busy = useAppStore((state) => state.busy)
  const modelSelectionReady = useAppStore((state) => state.modelSelectionReady)
  const hasSession = useAppStore(
    (state) => state.selection.sessionId !== undefined,
  )
  const setPromptDraft = useAppStore((state) => state.setPromptDraft)
  const admitInput = useAppStore((state) => state.admitInput)
  const view = useExecutionView()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Autosize after every render; the composer re-renders exactly when the draft changes.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  })

  const text = draft.trim()
  const canSend = text.length > 0 && hasSession && modelSelectionReady && !busy

  const submit = () => {
    if (!canSend) return
    void admitInput(text)
  }

  return (
    <form
      className="space-y-2 border-t px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label="Send input to the Mate"
        value={draft}
        rows={1}
        placeholder={
          hasSession
            ? "Send input to the Mate"
            : "Create or select a session to start"
        }
        disabled={!hasSession}
        onChange={(event) => setPromptDraft(event.currentTarget.value)}
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
        className="max-h-50 min-h-9 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ModelSelector />
          <span className="text-xs text-muted-foreground">
            {view.lastTurnUsage === undefined
              ? "Enter to send · Shift+Enter for newline"
              : `last turn · ↑ ${view.lastTurnUsage.inputTokens} · ↓ ${view.lastTurnUsage.outputTokens} tokens`}
          </span>
        </div>
        <Button type="submit" size="sm" disabled={!canSend}>
          Send
        </Button>
      </div>
    </form>
  )
}
