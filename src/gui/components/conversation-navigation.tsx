import { useState } from "react"
import type { ExecutionEntry } from "../execution-view.ts"

function previewText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[#>*-]+\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
}

export function ConversationNavigation({
  entries,
  visibleInputs,
  onJump,
}: Readonly<{
  entries: readonly ExecutionEntry[]
  visibleInputs: ReadonlySet<string>
  onJump(inputId: string): void
}>) {
  const [hovered, setHovered] = useState<number>()
  const messages: { id: string; text: string; response: string }[] = []
  for (const entry of entries) {
    if (entry.kind === "user_input")
      messages.push({ id: entry.inputId, text: entry.text, response: "" })
    else if (entry.kind === "assistant") {
      const message = messages.at(-1)
      if (message) message.response = entry.text
    }
  }
  if (messages.length < 2) return null
  return (
    <nav
      aria-label="Conversation messages"
      className="conversation-navigation"
      onMouseLeave={() => setHovered(undefined)}
    >
      {messages.map((message, index) => {
        const distance = Math.abs(index - (hovered ?? -100))
        const active = visibleInputs.has(message.id)
        const width =
          distance === 0
            ? 26
            : distance === 1
              ? 20
              : distance === 2
                ? 14
                : distance === 3
                  ? 10
                  : active && hovered === undefined
                    ? 26
                    : 6
        return (
          <button
            key={message.id}
            type="button"
            aria-label={`Jump to message ${index + 1}: ${message.text.slice(0, 80)}`}
            aria-current={active ? "location" : undefined}
            className="conversation-marker"
            onMouseEnter={() => setHovered(index)}
            onFocus={() => setHovered(index)}
            onBlur={() => setHovered(undefined)}
            onClick={() => onJump(message.id)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setHovered(undefined)
              const next =
                event.key === "ArrowDown"
                  ? index + 1
                  : event.key === "ArrowUp"
                    ? index - 1
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? messages.length - 1
                        : undefined
              if (next === undefined) return
              event.preventDefault()
              const buttons =
                event.currentTarget.parentElement?.querySelectorAll("button")
              buttons?.[
                Math.max(0, Math.min(next, messages.length - 1))
              ]?.focus()
            }}
          >
            <span
              className="conversation-marker-line"
              style={{ transform: `scaleX(${width / 26})` }}
            />
            <span
              className="conversation-preview"
              data-visible={hovered === index}
              aria-hidden="true"
            >
              <span className="line-clamp-2 font-medium text-foreground">
                {previewText(message.text) || "Attached images"}
              </span>
              {message.response ? (
                <span className="mt-1.5 line-clamp-3 text-muted-foreground">
                  {previewText(message.response)}
                </span>
              ) : null}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
