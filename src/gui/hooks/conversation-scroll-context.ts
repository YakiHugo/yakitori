import { createContext } from "react"

// Like Codex's thread scroll controller, the transcript owns scrolling and
// exposes the explicit user jump to its composer through their shared surface.
export const ConversationScrollContext = createContext<Readonly<{
  jumpToBottom(): void
}> | null>(null)
