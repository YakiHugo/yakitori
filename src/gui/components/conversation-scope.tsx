import { createContext, useContext } from "react"
import { selectCurrentThreadId, useAppStore } from "../store/app-store.ts"

// A transcript's identity must never come from whichever other pane is selected.
// Containers own lifecycle and capabilities; message renderers share this scope.
export type ConversationScope = {
  sessionId: string | undefined
  threadId: string
  apiBase: string
  workspaceRoot: string | undefined
  editable: boolean
  interactiveQuestions: boolean
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
      editable: true,
      interactiveQuestions: true,
    }
  )
}
