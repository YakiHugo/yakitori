import { useLayoutEffect } from "react"
import { usePinnedScroll } from "../hooks/use-pinned-scroll.ts"
import { useAppStore, useExecutionView } from "../store/app-store.ts"
import { AssistantMessageCell } from "./cells/assistant-message-cell.tsx"
import { CompactionCell } from "./cells/compaction-cell.tsx"
import { PermissionCell } from "./cells/permission-cell.tsx"
import { ReasoningCell } from "./cells/reasoning-cell.tsx"
import { ToolCell } from "./cells/tool-cell.tsx"
import { TurnTerminalCell } from "./cells/turn-terminal-cell.tsx"
import { UserMessageCell } from "./cells/user-message-cell.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

export function Transcript() {
  const view = useExecutionView()
  const selectSession = useAppStore((state) => state.selectSession)
  const { viewportRef, onScroll, pinToBottom } = usePinnedScroll()

  useLayoutEffect(() => {
    pinToBottom()
  })

  const queued = new Set(view.queuedInputIds)

  return (
    <ScrollArea
      className="min-h-0 flex-1"
      viewportRef={viewportRef}
      onScroll={onScroll}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
        {view.entries.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Conversation will appear here
          </p>
        ) : (
          view.entries.map((entry) => {
            switch (entry.kind) {
              case "user_input":
                return (
                  <UserMessageCell
                    key={`input:${entry.inputId}`}
                    entry={entry}
                    queued={queued.has(entry.inputId)}
                  />
                )
              case "assistant":
                return (
                  <AssistantMessageCell
                    key={`assistant:${entry.itemId}`}
                    entry={entry}
                  />
                )
              case "reasoning":
                return (
                  <ReasoningCell
                    key={`reasoning:${entry.itemId}`}
                    entry={entry}
                  />
                )
              case "tool":
                return (
                  <ToolCell
                    key={`tool:${entry.toolCallId}`}
                    entry={entry}
                    workspaceRoot={view.workingDirectory}
                    onOpenSession={selectSession}
                  />
                )
              case "permission":
                return (
                  <PermissionCell
                    key={`permission:${entry.permissionRequestId}`}
                    entry={entry}
                  />
                )
              case "turn_terminal":
                return (
                  <TurnTerminalCell
                    key={`terminal:${entry.turnId}:${entry.state}`}
                    entry={entry}
                  />
                )
              case "context_compacted":
                return (
                  <CompactionCell
                    key={`compaction:${entry.compactionId}`}
                    entry={entry}
                  />
                )
              default:
                return null
            }
          })
        )}
      </div>
    </ScrollArea>
  )
}
