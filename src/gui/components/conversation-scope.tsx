import { createContext, useContext } from "react"
import { selectCurrentThreadId, useAppStore } from "../store/app-store.ts"

// A transcript's identity must never come from whichever other pane is selected.
// Containers own lifecycle and capabilities; message renderers share this scope.
export type ConversationCapabilities = Readonly<{
  editable: boolean
  supportsContextExcerpts: boolean
  historyOwnership: "canonical" | "observed"
}>

export type ConversationScope = {
  sessionId: string | undefined
  engineId?: string | undefined
  threadId: string
  apiBase: string
  workspaceRoot: string | undefined
  capabilities: ConversationCapabilities
  interactiveQuestions: boolean
  focusItemId?: string | undefined
  loadTurnActivity?(turnId: string): Promise<void>
}

export const ConversationScopeContext = createContext<
  ConversationScope | undefined
>(undefined)

export function useConversationScope(): ConversationScope {
  const override = useContext(ConversationScopeContext)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const threadId = useAppStore(selectCurrentThreadId)
  const apiBase = useAppStore((state) => state.apiBase)
  const workspaceRoot = useAppStore((state) => state.execution.workingDirectory)
  return (
    override ?? {
      sessionId,
      threadId,
      apiBase,
      workspaceRoot,
      capabilities: {
        editable: true,
        supportsContextExcerpts: true,
        historyOwnership: "canonical",
      },
      interactiveQuestions: true,
    }
  )
}
